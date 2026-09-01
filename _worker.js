import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 1. Discord 署名検証
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const bodyText = await request.text();

    const isValidRequest = verifyKey(
      bodyText,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY
    );

    if (!isValidRequest) {
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(bodyText);

    // 2. PING (Discord 接続確認)
    if (interaction.type === InteractionType.PING) {
      return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. /deck コマンド処理
    if (
      interaction.type === InteractionType.APPLICATION_COMMAND &&
      interaction.data.name === 'deck'
    ) {
      const interactionToken = interaction.token;
      const appId = env.DISCORD_APPLICATION_ID;

      // 画像アタッチメントの取得
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

      // バックグラウンドで非同期処理を実行（3秒タイムアウト回避）
      ctx.waitUntil(
        processDeckAndFollowup(attachment.url, appId, interactionToken, env)
      );

      // 即座に「解析中...」レスポンスを返答
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

async function processDeckAndFollowup(imageUrl, appId, token, env) {
  const followupUrl = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;

  try {
    // 1. 画像ダウンロード
    const imageRes = await fetch(imageUrl);
    const imageBuffer = await imageRes.arrayBuffer();
    const base64Image = arrayBufferToBase64(imageBuffer);
    const mimeType = imageRes.headers.get('content-type') || 'image/jpeg';

    // 2. Gemini API 呼び出し
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const prompt = `
    添付されたトレーディングカードゲーム「蟲神器」のデッキリスト画像を解析してください。
    画像に含まれるすべてのカードについて、以下の情報を正確に読み取り、JSON配列形式で出力してください。

    抽出項目:
    - card_name: カード名（例: "オオアカエダカマキリ", "ヘラクレスオオカブト", "空蝉の皮鎧"）
    - color: カードの色（"赤", "青", "緑", "無色", "術・強化"）
    - cost: カード左上のコスト数値（0〜10の整数）
    - count: 画像内の枚数（1または2）

    出力形式はJSONのみとし、余計なマークダウン装飾（\`\`\`jsonなど）は除外してください。
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
    };

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload),
    });

    const geminiData = await geminiRes.json();
    let textResult =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    textResult = textResult.replace(/```json/g, '').replace(/```/g, '').trim();
    const cardsDetected = JSON.parse(textResult);

    // 3. スプレッドシートからマスターデータ取得
    const sheetRes = await fetch(env.MASTER_SHEET_CSV_URL);
    const sheetCsvText = await sheetRes.text();
    const masterRows = parseCSV(sheetCsvText);

    // 4. カード照合
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
        matchedIndex = masterRows.findIndex((r) => r.card_name === name);
      }

      if (matchedIndex !== -1) {
        outputCounts[matchedIndex] += count;
        totalMatched += count;
        summaryLines.push(`・${name} (${color}/コスト${cost}): ${count}枚`);
      } else {
        summaryLines.push(`⚠️ 照合失敗: ${name} (${color}/コスト${cost})`);
      }
    }

    // 出力用CSV構築
    let csvContent = 'image,label,item-count,item-key\n';
    for (let i = 0; i < masterRows.length; i++) {
      const r = masterRows[i];
      csvContent += `"${r.image_url}","${r.original_label}",${outputCounts[i]},"${r['item-key']}"\n`;
    }

    const summaryText =
      `【解析完了】計 ${totalMatched} 枚を照合しました。\n` +
      summaryLines.join('\n');

    // 5. Discordに返答メッセージとCSVファイルを送信
    const formData = new FormData();
    formData.append(
      'payload_json',
      JSON.stringify({ content: summaryText })
    );
    formData.append(
      'files[0]',
      new Blob([csvContent], { type: 'text/csv' }),
      'playingcards_deck_import.csv'
    );

    await fetch(followupUrl, {
      method: 'PATCH',
      body: formData,
    });
  } catch (err) {
    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `❌ エラーが発生しました: ${err.message}`,
      }),
    });
  }
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
