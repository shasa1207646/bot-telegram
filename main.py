import os
import logging
import asyncio
from datetime import datetime, timedelta
from threading import Thread
import requests
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)

load_dotenv()

# ─── Настройки ───────────────────────────────────────────────────────────────
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ADMIN_CHAT_ID = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "")
RAILWAY_URL = os.environ.get("RAILWAY_CALLBACK_URL", "")
RAILWAY_AUTH_URL = os.environ.get("RAILWAY_AUTH_URL", "")
SECRET = os.environ.get("INTERNAL_SECRET", "")
PORT = int(os.environ.get("PORT", 3000))

if not TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN не задан!")

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

# ─── In-memory сессии модераторов ────────────────────────────────────────────
# { telegram_user_id: { discord_username, discord_user_id, is_moderator, expires_at } }
mod_sessions: dict[int, dict] = {}


def get_session(user_id: int) -> dict | None:
    s = mod_sessions.get(user_id)
    if not s:
        return None
    if datetime.now() > s["expires_at"]:
        mod_sessions.pop(user_id, None)
        return None
    return s


# ─── Команды бота ─────────────────────────────────────────────────────────────
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🎮 *Бот администрации сервера*\n\n"
        "Команды:\n"
        "/auth — авторизоваться через Discord\n"
        "/whoami — мой профиль\n"
        "/help — помощь",
        parse_mode="Markdown",
    )


async def cmd_auth(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    auth_url = f"{RAILWAY_AUTH_URL}?telegram_id={user_id}"
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton("🔗 Войти через Discord", url=auth_url)
    ]])
    await update.message.reply_text(
        "🔐 *Авторизация через Discord*\n\nНажмите кнопку ниже для входа:",
        parse_mode="Markdown",
        reply_markup=keyboard,
    )


async def cmd_whoami(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    session = get_session(user_id)
    if not session:
        await update.message.reply_text(
            "❌ Вы не авторизованы. Используйте /auth для входа через Discord."
        )
        return
    expires = session["expires_at"].strftime("%d.%m.%Y")
    mod_status = "✅ Да" if session["is_moderator"] else "❌ Нет"
    await update.message.reply_text(
        f"👤 *Ваш профиль*\n\n"
        f"Discord: {session['discord_username']}\n"
        f"Модератор: {mod_status}\n"
        f"Сессия истекает: {expires}",
        parse_mode="Markdown",
    )


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📖 *Помощь*\n\n"
        "/auth — войти через Discord для верификации роли модератора\n"
        "/whoami — посмотреть свой статус\n\n"
        "⚠️ Для принятия/отклонения заявок нужна роль Модератора на Discord-сервере.",
        parse_mode="Markdown",
    )


# ─── Inline-кнопки (принять / отклонить) ─────────────────────────────────────
async def callback_handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data or ""
    user = query.from_user
    user_id = user.id
    username = f"@{user.username}" if user.username else user.first_name

    if not (data.startswith("approve_") or data.startswith("reject_")):
        return

    action, app_id = data.split("_", 1)

    # Проверить сессию
    session = get_session(user_id)
    if not session:
        await query.answer("⚠️ Сначала авторизуйтесь: /auth", show_alert=True)
        return

    if not session["is_moderator"]:
        await query.answer("🚫 У вас нет роли модератора на Discord-сервере!", show_alert=True)
        return

    await query.answer("⏳ Обрабатываю...")

    # Отправить решение на Railway
    try:
        resp = requests.post(
            RAILWAY_URL,
            json={
                "application_id": int(app_id),
                "action": action,
                "moderator_telegram_id": user_id,
                "moderator_username": username,
            },
            headers={"x-internal-secret": SECRET},
            timeout=10,
        )
        resp.raise_for_status()
    except Exception as e:
        log.error("Ошибка отправки решения на Railway: %s", e)
        await ctx.bot.send_message(query.message.chat.id, "❌ Ошибка при обработке. Попробуйте снова.")
        return

    # Обновить сообщение — убрать кнопки, добавить статус
    status_emoji = "✅" if action == "approve" else "❌"
    status_text = "Принята" if action == "approve" else "Отклонена"
    original = query.message.text or ""
    await query.edit_message_text(
        f"{original}\n\n{status_emoji} *{status_text}*\n"
        f"Модератор: {username} (Discord: {session['discord_username']})",
        parse_mode="Markdown",
    )


# ─── Flask — webhook-эндпоинты от Railway ─────────────────────────────────────
flask_app = Flask(__name__)

# Глобальная ссылка на Telegram Application (заполняется в main)
tg_app: Application | None = None


def _check_secret(req) -> bool:
    return req.headers.get("x-internal-secret") == SECRET


@flask_app.route("/bot/application", methods=["POST"])
def receive_application():
    if not _check_secret(request):
        return jsonify({"error": "Forbidden"}), 403

    app_data = request.json
    if not app_data or not app_data.get("id"):
        return jsonify({"error": "Нет данных заявки"}), 400

    type_map = {
        "curator": "👑 Заявка на куратора",
        "moderator": "🛡️ Заявка на модератора",
    }
    type_label = type_map.get(app_data.get("type", ""), "🎮 Заявка на вступление")

    submitted_raw = app_data.get("submitted_at")
    if submitted_raw:
        try:
            dt = datetime.fromisoformat(submitted_raw.replace("Z", "+00:00"))
            date_str = dt.strftime("%d.%m.%Y %H:%M")
        except Exception:
            date_str = submitted_raw
    else:
        date_str = datetime.now().strftime("%d.%m.%Y %H:%M")

    lines = [
        f"{type_label} *#{app_data['id']}*\n",
        f"👤 Discord: {app_data.get('username', '—')}",
        f"🎂 Возраст: {app_data.get('age', '—')} лет",
        f"📛 Имя: {app_data.get('name', '—')}",
        f"⏱ Активность: {app_data.get('activity', '—')}",
        f"🎯 Игры: {app_data.get('games') or '—'}",
        f"✅ Правила: {'Принимает' if app_data.get('rules') else 'Не принимает'}",
    ]

    app_type = app_data.get("type", "member")
    if app_type in ("curator", "moderator"):
        lines.append(f"\n📋 Опыт: {app_data.get('experience') or '—'}")
        lines.append(f"💬 Мотивация: {app_data.get('motivation') or '—'}")

    lines.append(f"\n📅 Подано: {date_str}")
    text = "\n".join(lines)

    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton("✅ Принять", callback_data=f"approve_{app_data['id']}"),
        InlineKeyboardButton("❌ Отклонить", callback_data=f"reject_{app_data['id']}"),
    ]])

    # Отправить в Telegram из синхронного контекста Flask
    async def _send():
        await tg_app.bot.send_message(
            chat_id=ADMIN_CHAT_ID,
            text=text,
            parse_mode="Markdown",
            reply_markup=keyboard,
        )

    future = asyncio.run_coroutine_threadsafe(
        _send(),
        tg_app.bot._loop if hasattr(tg_app.bot, "_loop") else asyncio.get_event_loop(),
    )
    try:
        future.result(timeout=15)
        log.info("Заявка #%s отправлена в Telegram", app_data["id"])
        return jsonify({"success": True})
    except Exception as e:
        log.error("Ошибка отправки в Telegram: %s", e)
        return jsonify({"error": "Ошибка отправки"}), 500


@flask_app.route("/bot/session", methods=["POST"])
def receive_session():
    if not _check_secret(request):
        return jsonify({"error": "Forbidden"}), 403

    data = request.json or {}
    tg_id = data.get("telegram_user_id")
    if not tg_id:
        return jsonify({"error": "Нет telegram_user_id"}), 400

    mod_sessions[int(tg_id)] = {
        "discord_username": data.get("discord_username", ""),
        "discord_user_id": data.get("discord_user_id", ""),
        "is_moderator": bool(data.get("is_moderator")),
        "expires_at": datetime.now() + timedelta(days=7),
    }

    discord_name = data.get("discord_username", "")
    is_mod = bool(data.get("is_moderator"))
    msg = (
        f"✅ Авторизация успешна! Вы вошли как {discord_name}.\n"
        f"{'🛡️ Статус модератора подтверждён.' if is_mod else '⚠️ Роль модератора не обнаружена на сервере.'}"
    )

    async def _notify():
        await tg_app.bot.send_message(chat_id=int(tg_id), text=msg)

    asyncio.run_coroutine_threadsafe(
        _notify(),
        tg_app.bot._loop if hasattr(tg_app.bot, "_loop") else asyncio.get_event_loop(),
    )
    return jsonify({"success": True})


@flask_app.route("/healthz")
def healthz():
    return jsonify({"status": "ok", "bot": "polling"})


# ─── Запуск ───────────────────────────────────────────────────────────────────
def run_flask():
    flask_app.run(host="0.0.0.0", port=PORT, use_reloader=False)


async def main():
    global tg_app
    tg_app = (
        Application.builder()
        .token(TOKEN)
        .build()
    )

    # Регистрация хендлеров
    tg_app.add_handler(CommandHandler("start", cmd_start))
    tg_app.add_handler(CommandHandler("auth", cmd_auth))
    tg_app.add_handler(CommandHandler("whoami", cmd_whoami))
    tg_app.add_handler(CommandHandler("help", cmd_help))
    tg_app.add_handler(CallbackQueryHandler(callback_handler))

    # Flask в отдельном потоке
    flask_thread = Thread(target=run_flask, daemon=True)
    flask_thread.start()
    log.info("Flask запущен на порту %s", PORT)

    # Запуск polling
    log.info("Telegram бот запущен (polling)")
    async with tg_app:
        await tg_app.initialize()
        await tg_app.start()
        await tg_app.updater.start_polling(drop_pending_updates=True)
        # Держим бота живым
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
