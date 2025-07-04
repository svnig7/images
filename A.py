file-search-bot/
├── bot.py               # Main bot logic and handlers
├── config.py            # Config with API keys, IDs, etc.
├── database.py          # MongoDB file/user handling
├── requirements.txt     # Python dependencies
├── Dockerfile           # For container deployment (optional)
├── README.md            # Project overview

# config.py

API_ID = 12345678
API_HASH = "your_api_hash"
BOT_TOKEN = "your_bot_token"
MONGO_URI = "your_mongo_uri"

FORCE_CHANNEL = -1001234567890
FORCE_GROUP = -1009876543210
LOG_CHANNEL = -1001122334455
BOT_OWNER_ID = 111111111
INDEX_CHANNELS = [-1001234567890]


# requirements.txt

pyrogram==2.0.106
tgcrypto==1.2.5
pymongo[srv]
humanize


# database.py

from pymongo import MongoClient
from config import MONGO_URI

client = MongoClient(MONGO_URI)
db = client["file_search"]

files_collection = db["files"]
users_collection = db["users"]

def save_file(file_id, caption, message_id, chat_id):
    data = {
        "file_id": file_id,
        "caption": caption or "",
        "message_id": message_id,
        "chat_id": chat_id,
    }
    files_collection.update_one({"file_id": file_id}, {"$set": data}, upsert=True)

def search_files(query):
    return list(files_collection.find({"caption": {"$regex": query, "$options": "i"}}))

def delete_files_by_query(query):
    return files_collection.delete_many({"caption": {"$regex": query, "$options": "i"}})

def get_total_file_count():
    return files_collection.count_documents({})

def save_user(user_id, name):
    users_collection.update_one({"_id": user_id}, {"$set": {"name": name}}, upsert=True)

def get_total_user_count():
    return users_collection.count_documents({})


# Dockerfile

FROM python:3.11-slim

WORKDIR /app

COPY . .

RUN pip install --no-cache-dir -r requirements.txt

CMD ["python", "bot.py"]


# bot.py

from pyrogram import Client, filters
from pyrogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, InlineQuery, InlineQueryResultArticle, InputTextMessageContent, CallbackQuery
from pyrogram.enums import ChatMemberStatus
from pyrogram.errors import UserNotParticipant

from config import API_ID, API_HASH, BOT_TOKEN, INDEX_CHANNELS, FORCE_CHANNEL, FORCE_GROUP, BOT_OWNER_ID, LOG_CHANNEL
from database import save_file, search_files, delete_files_by_query, get_total_file_count, save_user, get_total_user_count, files_collection
import humanize

app = Client("file-search-bot", api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN)

user_cache = set()

async def check_force_sub(client, user_id):
    try:
        user = await client.get_users(user_id)
        save_user(user.id, user.first_name)
        if user_id not in user_cache and LOG_CHANNEL:
            await client.send_message(LOG_CHANNEL, f"👤 New user: [{user.first_name}](tg://user?id={user.id}) (`{user.id}`)")
            user_cache.add(user_id)
    except:
        pass

    def join_btn(chat, name):
        try:
            if chat.username:
                return InlineKeyboardButton(name, url=f"https://t.me/{chat.username}")
            invite = client.export_chat_invite_link(chat.id)
            return InlineKeyboardButton(name, url=invite)
        except:
            return InlineKeyboardButton(name, url="https://t.me")

    try:
        ch_member = await client.get_chat_member(FORCE_CHANNEL, user_id)
        if ch_member.status not in [ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
            raise UserNotParticipant
    except:
        return False, InlineKeyboardMarkup([
            [join_btn(await client.get_chat(FORCE_CHANNEL), "📢 Join Channel"), join_btn(await client.get_chat(FORCE_GROUP), "👥 Join Group")],
            [InlineKeyboardButton("🔄 Refresh", callback_data="refresh_force")]
        ])

    try:
        grp_member = await client.get_chat_member(FORCE_GROUP, user_id)
        if grp_member.status not in [ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.OWNER]:
            raise UserNotParticipant
    except:
        return False, InlineKeyboardMarkup([
            [join_btn(await client.get_chat(FORCE_CHANNEL), "📢 Join Channel"), join_btn(await client.get_chat(FORCE_GROUP), "👥 Join Group")],
            [InlineKeyboardButton("🔄 Refresh", callback_data="refresh_force")]
        ])

    return True, None

@app.on_callback_query(filters.regex("refresh_force"))
async def refresh_force_sub(client, cb):
    ok, _ = await check_force_sub(client, cb.from_user.id)
    if not ok:
        return await cb.answer("❌ Still not joined.", show_alert=True)
    await cb.message.delete()
    await cb.answer("✅ Verified!")

@app.on_message(filters.command("start"))
async def start_cmd(client, msg: Message):
    ok, kb = await check_force_sub(client, msg.from_user.id)
    if not ok:
        return await msg.reply("🔒 Please join required channels to use the bot.", reply_markup=kb)
    param = msg.command[1] if len(msg.command) > 1 else ""
    if param.startswith("send_"):
        _, chat_id, message_id = param.split("_")
        try:
            await client.copy_message(chat_id=msg.chat.id, from_chat_id=int(chat_id), message_id=int(message_id))
        except:
            await msg.reply("❌ Failed to send file.")
        return
    await msg.reply("👋 Welcome! Use /search <query> to begin.")

@app.on_message(filters.command("search"))
async def search_handler(client, msg: Message):
    ok, kb = await check_force_sub(client, msg.from_user.id)
    if not ok:
        return await msg.reply("🔒 Please join required channels to use this bot.", reply_markup=kb)

    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2:
        return await msg.reply("Usage: /search <query>")

    query = parts[1]
    page = 1
    limit = 5
    files = search_files(query)
    total = len(files)
    total_pages = (total + limit - 1) // limit
    results = files[(page - 1) * limit : page * limit]

    if not results:
        return await msg.reply("No results found.")

    from config import SEND_FILE_INSTEAD_OF_LINK
    if SEND_FILE_INSTEAD_OF_LINK:
        for f in results:
            try:
                await client.copy_message(chat_id=msg.chat.id, from_chat_id=f['chat_id'], message_id=f['message_id'])
            except:
                pass
        return

    text = f"🔍 **Results for:** `{query}` (Page {page}/{total_pages})\n\n"
    for i, file in enumerate(results, 1):
        link = f"https://t.me/c/{str(file['chat_id'])[4:]}/{file['message_id']}"
        text += f"{i}. [{file['caption'][:50]}]({link})\n"

    buttons = []
    if total_pages > 1:
        buttons.append([InlineKeyboardButton("Next ⏩", callback_data=f"page_{query}_2")])

    await msg.reply(text, reply_markup=InlineKeyboardMarkup(buttons) if buttons else None, disable_web_page_preview=True)

@app.on_callback_query(filters.regex(r"^page_(.+)_(\d+)$"))
async def pagination_callback(client, query: CallbackQuery):
    from config import SEND_FILE_INSTEAD_OF_LINK
    q, p = query.matches[0].group(1), int(query.matches[0].group(2))
    files = search_files(q)
    limit = 5
    total = len(files)
    total_pages = (total + limit - 1) // limit
    results = files[(p - 1) * limit : p * limit]
    if not results:
        return await query.answer("No more results.")

    if SEND_FILE_INSTEAD_OF_LINK:
        await query.message.delete()
        for f in results:
            try:
                await client.copy_message(chat_id=query.from_user.id, from_chat_id=f['chat_id'], message_id=f['message_id'])
            except:
                pass
        return await query.answer("✅ Files sent via bot.")

    text = f"🔍 **Results for:** `{q}` (Page {p}/{total_pages})\n\n"
    for i, file in enumerate(results, 1):
        link = f"https://t.me/c/{str(file['chat_id'])[4:]}/{file['message_id']}"
        text += f"{i}. [{file['caption'][:50]}]({link})\n"

    buttons = []
    nav = []
    if p > 1:
        nav.append(InlineKeyboardButton("⏪ Prev", callback_data=f"page_{q}_{p-1}"))
    if p < total_pages:
        nav.append(InlineKeyboardButton("Next ⏩", callback_data=f"page_{q}_{p+1}"))
    if nav:
        buttons.append(nav)

    await query.message.edit_text(text, reply_markup=InlineKeyboardMarkup(buttons) if buttons else None, disable_web_page_preview=True)
    await query.answer()

@app.on_message(filters.command("indexall"))
async def index_all_files(client, msg: Message):
    if msg.from_user.id != BOT_OWNER_ID:
        return await msg.reply("❌ Only the bot owner can use this command.")
    ok, kb = await check_force_sub(client, msg.from_user.id)
    if not ok:
        return await msg.reply("🔒 Please join required channels.", reply_markup=kb)

    await msg.reply("📦 Indexing started...")
    total = 0
    for channel_id in INDEX_CHANNELS:
        async for m in client.get_chat_history(channel_id, limit=0):
            media = m.document or m.video or m.audio
            if media:
                save_file(media.file_id, m.caption, m.id, m.chat.id)
                total += 1
    await msg.reply(f"✅ Indexed {total} files.")

@app.on_message(filters.command("stats"))
async def stats_handler(client, msg: Message):
    ok, kb = await check_force_sub(client, msg.from_user.id)
    if not ok:
        return await msg.reply("🔒 Please join required channels.", reply_markup=kb)

    total_files = get_total_file_count()
    total_users = get_total_user_count()

    total_size = 0
    for f in files_collection.find({}, {"_id": 0, "file_id": 1, "chat_id": 1, "message_id": 1}):
        try:
            file = await client.get_messages(f['chat_id'], f['message_id'])
            media = file.document or file.video or file.audio
            if media and media.file_size:
                total_size += media.file_size
        except:
            pass

    await msg.reply(
        f"📊 **Bot Statistics:**\n\n"
        f"👥 Total Users: `{total_users}`\n"
        f"📁 Total Files: `{total_files}`\n"
        f"💾 Storage Used: `{humanize.naturalsize(total_size)}`"
    )

@app.on_message(filters.command("broadcast") & filters.private)
async def broadcast_handler(client, msg: Message):
    if msg.from_user.id != BOT_OWNER_ID:
        return await msg.reply("❌ Only the bot owner can broadcast.")

    if len(msg.command) < 2:
        return await msg.reply("Usage: /broadcast <message>")

    text = msg.text.split(None, 1)[1]
    users = users_collection.find({})
    success, failed = 0, 0

    for user in users:
        try:
            await client.send_message(user["_id"], text)
            success += 1
        except:
            failed += 1

    await msg.reply(f"✅ Broadcast sent to {success} users.\n❌ Failed: {failed}")

@app.on_inline_query()
async def inline_query_handler(client, inline_query: InlineQuery):
    from config import SEND_FILE_INSTEAD_OF_LINK
    ok, _ = await check_force_sub(client, inline_query.from_user.id)
    if not ok:
        return await client.answer_inline_query(
            inline_query.id,
            results=[],
            switch_pm_text="🔐 Join required channel & group",
            switch_pm_parameter="force_sub"
        )

    query = inline_query.query.strip()
    results = []
    if query:
        files = search_files(query)[:10]
        if SEND_FILE_INSTEAD_OF_LINK:
            for file in files:
                # This will just send a button that triggers deep link for /start
                results.append(
                    InlineQueryResultArticle(
                        title=file['caption'][:60] if file['caption'] else "Unnamed",
                        input_message_content=InputTextMessageContent(
                            f"Send this file: /start send_{file['chat_id']}_{file['message_id']}"
                        ),
                        description="Click to send via bot"
                    )
                )
        else:
            for file in files:
                link = f"https://t.me/c/{str(file['chat_id'])[4:]}/{file['message_id']}"
                title = file['caption'][:60] if file['caption'] else "Unnamed"
                results.append(
                    InlineQueryResultArticle(
                        title=title,
                        input_message_content=InputTextMessageContent(f"[{title}]({link})", disable_web_page_preview=True),
                        description="Click to view",
                    )
                )
    await client.answer_inline_query(inline_query.id, results, cache_time=1)

@app.on_message(filters.channel & (filters.document | filters.video | filters.audio))
async def auto_index_file(client, msg: Message):
    if msg.chat.id in INDEX_CHANNELS:
        media = msg.document or msg.video or msg.audio
        if media:
            save_file(media.file_id, msg.caption, msg.id, msg.chat.id)

@app.on_message(filters.command("help"))
async def help_cmd(client, msg: Message):
    ok, kb = await check_force_sub(client, msg.from_user.id)
    if not ok:
        return await msg.reply("🔒 Please join required channels to use the bot.", reply_markup=kb)

    text = (
        "**📚 Bot Commands:**\n\n"
        "/start - Show welcome message\n"
        "/help - Show this help menu\n"
        "/search <query> - Search for files\n"
        "/stats - Show bot statistics\n\n"
        "**🔐 Admin Commands:**\n"
        "/indexall - Re-index all files from channels\n"
        "/broadcast <text> - Send message to all users\n\n"
        "**🔎 Inline Mode:**\n"
        "Type `@YourBotName query` in any chat to search inline."
    )
    await msg.reply(text, disable_web_page_preview=True)

@app.on_message(filters.command("settings"))
async def settings_cmd(client, msg: Message):
    from config import SEND_FILE_INSTEAD_OF_LINK
    ok, kb = await check_force_sub(client, msg.from_user.id)
    if not ok:
        return await msg.reply("🔒 Please join required channels to use the bot.", reply_markup=kb)

    if msg.from_user.id != BOT_OWNER_ID:
        return await msg.reply("❌ Only the bot owner can view settings.")

    await msg.reply(
        f"**⚙️ Bot Settings:**\n\n"
        f"🔗 Force Channel: `{FORCE_CHANNEL}`\n"
        f"👥 Force Group: `{FORCE_GROUP}`\n"
        f"📤 Send File Instead of Link: `{SEND_FILE_INSTEAD_OF_LINK}`\n"
        f"📚 Indexed Channels: `{INDEX_CHANNELS}`\n"
    )

@app.on_message(filters.command("admin"))
async def admin_cmd(client, msg: Message):
    if msg.from_user.id != BOT_OWNER_ID:
        return await msg.reply("❌ Only the bot owner can access this panel.")

    text = (
        "**🛠️ Admin Panel**\n\n"
        f"🔗 Force Channel: `{FORCE_CHANNEL}`\n"
        f"👥 Force Group: `{FORCE_GROUP}`\n"
        f"📤 Send File Mode: `{SEND_FILE_INSTEAD_OF_LINK}`\n"
    )
    buttons = [
        [InlineKeyboardButton("🔁 Toggle Send Mode", callback_data="toggle_send_mode")],
        [InlineKeyboardButton("🔄 Reload Config", callback_data="reload_config")]
    ]
    await msg.reply(text, reply_markup=InlineKeyboardMarkup(buttons))

@app.on_callback_query(filters.regex("toggle_send_mode"))
async def toggle_send_mode(client, cb: CallbackQuery):
    if cb.from_user.id != BOT_OWNER_ID:
        return await cb.answer("Unauthorized", show_alert=True)

    new_state = not cfg.SEND_FILE_INSTEAD_OF_LINK
    with open("config.py", "r") as f:
        content = f.read()
    content = content.replace(
        f"SEND_FILE_INSTEAD_OF_LINK = {cfg.SEND_FILE_INSTEAD_OF_LINK}",
        f"SEND_FILE_INSTEAD_OF_LINK = {new_state}"
    )
    with open("config.py", "w") as f:
        f.write(content)
    cfg.SEND_FILE_INSTEAD_OF_LINK = new_state
    await cb.answer("Toggled send mode.", show_alert=True)
    await cb.message.edit_text("✅ Send mode toggled. Please restart the bot to apply changes.")

@app.on_callback_query(filters.regex("reload_config"))
async def reload_config(client, cb: CallbackQuery):
    if cb.from_user.id != BOT_OWNER_ID:
        return await cb.answer("Unauthorized", show_alert=True)

    import importlib
    importlib.reload(cfg)
    await cb.answer("🔄 Config reloaded.", show_alert=True)
    await cb.message.edit_text("✅ Configuration reloaded successfully.")

app.run()
