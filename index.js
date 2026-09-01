import { WorkflowEntrypoint } from 'cloudflare:workers';
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

// 1. バックグラウンドで実行される非同期ワークフロー
export class DeckAnalysisWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { imageUrl, appId, token } = event.payload;
    const env = this.env;
    const followupUrl = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;

    await step.do('analyze-deck-and-reply', async () => {
      try {
        console.log('--- ワークフロー処理開始 ---');

        // 画像取得 & マスターデータ取得
        const imagePromise = (async () => {
          const res = await fetch(imageUrl);
          const buffer = await res.arrayBuffer();
          return {
            base64: arrayBufferToBase64(buffer),
            mimeType: res.headers.get('content-type') || 'image/jpeg',
          };
        })();

        const sheetPromise = (async () => {
          const res = await fetch(env.MASTER_SHEET_CSV_URL);
          const text = await res.text();
          return parseCSV(text);
        })();

        // APIキー抽出
        const apiKeys = [];
        if (env.GEMINI_API_KEY) {
          env.GEMINI_API_KEY.split(',').forEach((k) => {
            const trimmed = k.trim();
            if (trimmed) apiKeys.push(trimmed);
          });
        }
        for (let i = 2; i <= 10; i++) {
          const keyName = `GEMINI_API_KEY_${i}`;
          if (env[keyName]) {
            const trimmed = env[keyName].trim();
            if (trimmed && !apiKeys.includes(trimmed)) apiKeys.push(trimmed);
          }
        }

        if (apiKeys.length === 0) {
          throw new Error('GEMINI_API_KEY が設定されていません。');
        }

        const [{ base64: base64Image, mimeType }, masterRows] = await Promise.all([
          imagePromise,
          sheetPromise,
        ]);

        const prompt = `
        添付されたトレーディングカードゲーム「蟲神器」のデッキリスト画像を非常に精密に解析してください。
        画像に含まれるすべてのカードについて、以下の情報を正確に読み取ってください。

        - card_name: カード名（漢字・ひらがな・カタカナを正確に読み取ってください）
        - color: カードの色（"赤", "青", "緑", "無色", "術・強化"）
        - cost: カード左上のコスト数値（0〜10の整数）
        - count: 画像内の同名カードの枚数（1または2）

        出力は以下のプロパティを持つJSONオブジェクトの配列として出力してください:
        [{"card_name": "オオアカエダカマキリ", "color": "赤", "cost": 6, "count": 1}]
        `;

        const geminiPayload = {
          contents: [
            {
              parts: [
                { inlineData: { mimeType: mimeType, data: base64Image } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.0,
          },
        };

        // 複数キーでのGemini呼び出し（順次フォールバック）
        const geminiData = await fetchGeminiSequential(apiKeys, geminiPayload);
        const textResult = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        const cardsDetected = JSON.parse(textResult);

        // カード照合処理
        let totalMatched = 0;
        const summaryLines = [];
        const outputCounts = new Array(masterRows.length).fill(0);

        for (const card of cardsDetected) {
          const name = String(card.card_name || '').trim();
          const color = String(card.color || '').trim();
          const cost = String(card.cost ?? '').trim();
          const count = Number(card.count || 1);

          let matchedIndex = masterRows.findIndex(
            (r) =>
              r.card_name === name &&
              r.color_name === color &&
              String(r.cost) === cost
          );

          if (matchedIndex === -1) {
            const sameColorCostCandidates = masterRows
              .map((r, idx) => ({ row: r, index: idx }))
              .filter(
                ({ row }) =>
                  row.color_name === color && String(row.cost) === cost
              );

            if (sameColorCostCandidates.length > 0) {
              let minDistance = Infinity;
              let bestCandidateIndex = -1;

              for (const candidate of sameColorCostCandidates) {
                const dist = getLevenshteinDistance(name, candidate.row.card_name);
                if (dist < minDistance) {
                  minDistance = dist;
                  bestCandidateIndex = candidate.index;
                }
              }
              matchedIndex = bestCandidateIndex;
            }
          }

          if (matchedIndex === -1) {
            matchedIndex = masterRows.findIndex((r) => r.card_name === name);
          }

          if (matchedIndex !== -1) {
            const matchedCard = masterRows[matchedIndex];
            outputCounts[matchedIndex] += count;
            totalMatched += count;
            summaryLines.push(
              `・${matchedCard.card_name} (${color}/コスト${cost}): ${count}枚`
            );
          } else {
            summaryLines.push(`⚠️ 照合失敗: ${name} (${color}/コスト${cost})`);
          }
        }

        // CSV生成
        let csvContent = 'image,label,item-count,item-key\n';
        for (let i = 0; i < masterRows.length; i++) {
          const r = masterRows[i];
          csvContent += `"${r.image_url}","${r.original_label}",${outputCounts[i]},"${r['item-key']}"\n`;
        }

        const summaryText =
          `【解析完了】計 ${totalMatched} 枚を照合しました。\n` +
          summaryLines.join('\n');

        // Discordへ結果送信
        const formData = new FormData();
        formData.append('payload_json', JSON.stringify({ content: summaryText }));
        formData.append(
          'files[0]',
          new Blob([csvContent], { type: 'text/csv' }),
          'playingcards_deck_import.csv'
        );

        await fetch(followupUrl, {
          method: 'PATCH',
          body: formData,
        });
        console.log('--- ワークフロー処理完了 ---');
      } catch (err) {
        console.error('ワークフロー処理失敗:', err.message);
        await fetch(followupUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `❌ エラーが発生しました:\n> ${err.message}`,
          }),
        });
      }
    });
  }
}

// 2. メイン Worker（Discordインタラクション受信）
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const bodyText = await request.text();

    const isValidRequest = await verifyKey(
      bodyText,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY
    );

    if (!isValidRequest) {
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(bodyText);

    if (interaction.type === InteractionType.PING) {
      return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (
      interaction.type === InteractionType.APPLICATION_COMMAND &&
      interaction.data.name === 'deck'
    ) {
      const interactionToken = interaction.token;
      const appId = env.DISCORD_APPLICATION_ID;

      const resolvedAttachments = interaction.data.resolved?.attachments;
      const optionImageId = interaction.data.options?.[0]?.value;
      const attachment = resolvedAttachments?.[optionImageId];

      if (!attachment || !attachment.url) {
        return new Response(
          JSON.stringify({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: '❌ 画像が見つかりませんでした。' },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Workflows を起動してバックグラウンド処理に移譲
      await env.DECK_WORKFLOW.create({
        params: {
          imageUrl: attachment.url,
          appId: appId,
          token: interactionToken,
        },
      });

      // Discord には即座に「考え中...」のレスポンスを返す
      return new Response(
        JSON.stringify({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Unknown interaction', { status: 400 });
  },
};

// ユーティリティ関数群
async function fetchGeminiSequential(apiKeys, payload) {
  let lastError = '';

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    console.log(`APIキー #${i + 1} を試行中...`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        console.log(`APIキー #${i + 1} で成功しました。`);
        return await res.json();
      }

      const errText = await res.text();
      lastError = `Key #${i + 1} (HTTP ${res.status}): ${errText}`;
      console.warn(`APIキー #${i + 1} 失敗 -> 次のキーへ。理由: HTTP ${res.status}`);
    } catch (err) {
      lastError = `Key #${i + 1} エラー: ${err.message}`;
      console.warn(`APIキー #${i + 1} 例外発生 -> 次のキーへ。`);
    }
  }

  throw new Error(`すべてのAPIキーで処理に失敗しました。\n詳細: ${lastError}`);
}

function getLevenshteinDistance(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function parseCSV(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length === 0) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] || '';
    });
    results.push(obj);
  }
  return results;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}
