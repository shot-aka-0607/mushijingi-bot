import os
import io
import json
import pandas as pd
from PIL import Image
import discord
from discord.ext import commands
from google import genai
from google.genai import types

# 環境変数の取得
DISCORD_TOKEN = os.getenv('DISCORD_BOT_TOKEN')
GEMINI_KEY = os.getenv('GEMINI_API_KEY')
MASTER_CSV_URL = os.getenv('MASTER_SHEET_CSV_URL')

# Gemini クライアント初期化
gemini_client = genai.Client(api_key=GEMINI_KEY)

# Discord Bot初期化
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix='!', intents=intents)

def get_master_data():
    """Web公開されたGoogleスプレッドシートからCSVを読み込む"""
    return pd.read_csv(MASTER_CSV_URL)

def analyze_and_match(image_bytes: bytes, master_df: pd.DataFrame):
    """Gemini APIによる画像解析とマスター照合"""
    image = Image.open(io.BytesIO(image_bytes))
    
    prompt = """
    添付されたトレーディングカードゲーム「蟲神器」のデッキリスト画像を解析してください。
    画像に含まれるすべてのカードについて、以下の情報を正確に読み取り、JSON配列形式で出力してください。

    抽出項目:
    - card_name: カード名（例: "オオアカエダカマキリ", "ヘラクレスオオカブト", "空蝉の皮鎧"）
    - color: カードの色（"赤", "青", "緑", "無色", "術・強化"）
    - cost: カード左上のコスト数値（0〜10の整数）
    - count: 画像内の枚数（1または2）

    出力例:
    [
      {"card_name": "オオアカエダカマキリ", "color": "赤", "cost": 6, "count": 1}
    ]
    """

    response = gemini_client.models.generate_content(
        model='gemini-2.5-flash',
        contents=[image, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.1
        )
    )

    cards_detected = json.loads(response.text)

    # インポート用CSVフレーム作成
    output_df = pd.DataFrame({
        'image': master_df['image_url'],
        'label': master_df['original_label'],
        'item-count': 0,
        'item-key': master_df['item-key']
    })

    summary_lines = []
    total_matched = 0

    for card in cards_detected:
        name = str(card.get('card_name', '')).strip()
        color = str(card.get('color', '')).strip()
        cost = str(card.get('cost', ''))
        count = card.get('count', 1)

        # 照合ロジック（名前 + 色 + コスト）
        mask = (
            (master_df['card_name'].astype(str) == name) & 
            (master_df['color_name'].astype(str) == color) & 
            (master_df['cost'].astype(str) == cost)
        )
        indices = master_df[mask].index

        # フォールバック（名前のみ）
        if len(indices) == 0:
            indices = master_df[master_df['card_name'].astype(str) == name].index

        if len(indices) > 0:
            idx = indices[0]
            output_df.loc[idx, 'item-count'] += count
            total_matched += count
            summary_lines.append(f"・{name} ({color}/コスト{cost}): {count}枚")
        else:
            summary_lines.append(f"⚠️ 照合失敗: {name} ({color}/コスト{cost})")

    csv_output = output_df.to_csv(index=False, encoding='utf-8')
    summary_text = f"【解析完了】計 {total_matched} 枚を照合しました。\n" + "\n".join(summary_lines)
    return csv_output, summary_text

@bot.event
async def on_ready():
    print(f"✅ Bot起動完了: {bot.user.name}")

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    images = [att for att in message.attachments if att.content_type and att.content_type.startswith('image/')]
    
    if images:
        status_msg = await message.channel.send("🔍 デッキ画像をクラウド上で解析中...")
        try:
            image_bytes = await images[0].read()
            master_df = get_master_data()
            csv_str, summary = analyze_and_match(image_bytes, master_df)

            csv_file = discord.File(
                fp=io.BytesIO(csv_str.encode('utf-8')),
                filename="playingcards_deck_import.csv"
            )
            await status_msg.edit(content=summary)
            await message.channel.send(content="📄 Playingcards.io用インポートCSVを出力しました！", file=csv_file)
        except Exception as e:
            await status_msg.edit(content=f"❌ エラーが発生しました: {e}")

    await bot.process_commands(message)

if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
