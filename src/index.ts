import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import axios from 'axios';

process.on('uncaughtException', err => console.error('[BotHost] Exception:', err));
process.on('unhandledRejection', reason => console.error('[BotHost] Rejection:', reason));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!;
const RAILWAY_URL = process.env.RAILWAY_CALLBACK_URL!;
const RAILWAY_AUTH = process.env.RAILWAY_AUTH_URL!;
const SECRET = process.env.INTERNAL_SECRET!;
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!TOKEN) {
  console.error('[BotHost] TELEGRAM_BOT_TOKEN не задан!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('[BotHost] Telegram бот запущен (polling)');

// ─── In-memory хранилище сессий ─────────────────────────────────────────────
// Структура: telegramUserId → { discordUsername, isModerator, expiresAt }
const modSessions = new Map<number, {
  discordUsername: string;
  discordUserId: string;
  isModerator: boolean;
  expiresAt: number;
}>();

function getSession(userId: number) {
  const s = modSessions.get(userId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { modSessions.delete(userId); return null; }
  return s;
}

// ─── Команды ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎮 *Бот администрации сервера*\n\n` +
    `Команды:\n` +
    `/auth — авторизоваться через Discord\n` +
    `/whoami — мой профиль\n` +
    `/pending — заявки в ожидании\n` +
    `/help — помощь`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/auth/, async (msg) => {
  const userId = msg.from!.id;
  const authUrl = `${RAILWAY_AUTH}?telegram_id=${userId}`;
  bot.sendMessage(msg.chat.id,
    `🔐 *Авторизация через Discord*\n\nНажмите кнопку ниже для входа:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔗 Войти через Discord', url: authUrl }
        ]]
      }
    }
  );
});

bot.onText(/\/whoami/, async (msg) => {
  const userId = msg.from!.id;
  const session = getSession(userId);
  if (!session) {
    return bot.sendMessage(msg.chat.id,
      '❌ Вы не авторизованы. Используйте /auth для входа через Discord.'
    );
  }
  const expiresDate = new Date(session.expiresAt).toLocaleDateString('ru-RU');
  bot.sendMessage(msg.chat.id,
    `👤 *Ваш профиль*\n\n` +
    `Discord: ${session.discordUsername}\n` +
    `Модератор: ${session.isModerator ? '✅ Да' : '❌ Нет'}\n` +
    `Сессия истекает: ${expiresDate}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *Помощь*\n\n` +
    `/auth — войти через Discord для верификации роли модератора\n` +
    `/whoami — посмотреть свой статус\n` +
    `/pending — список заявок в ожидании (только модераторы)\n\n` +
    `⚠️ Для принятия/отклонения заявок нужна роль Модератора на Discord-сервере.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Inline-кнопки ───────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const userId = query.from.id;
  const username = query.from.username ? '@' + query.from.username : query.from.first_name;

  // Обработка сессии после OAuth (bot получает уведомление через /bot/session)
  if (data.startsWith('approve_') || data.startsWith('reject_')) {
    const [action, appId] = data.split('_');

    // Проверить сессию модератора
    const session = getSession(userId);

    if (!session) {
      await bot.answerCallbackQuery(query.id, {
        text: '⚠️ Сначала авторизуйтесь: /auth',
        show_alert: true,
      });
      return;
    }

    if (!session.isModerator) {
      await bot.answerCallbackQuery(query.id, {
        text: '🚫 У вас нет роли модератора на Discord-сервере!',
        show_alert: true,
      });
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: '⏳ Обрабатываю...' });

    try {
      // Отправить решение на Railway
      await axios.post(RAILWAY_URL, {
        application_id: parseInt(appId),
        action,
        moderator_telegram_id: userId,
        moderator_username: username,
      }, {
        headers: { 'x-internal-secret': SECRET },
        timeout: 10000,
      });

      // Обновить сообщение
      const statusEmoji = action === 'approve' ? '✅' : '❌';
      const statusText = action === 'approve' ? 'Принята' : 'Отклонена';
      const originalText = query.message?.text || '';

      await bot.editMessageText(
        `${originalText}\n\n${statusEmoji} *${statusText}*\nМодератор: ${username} (Discord: ${session.discordUsername})`,
        {
          chat_id: query.message!.chat.id,
          message_id: query.message!.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [] },
        }
      );
    } catch (err: any) {
      console.error('[BotHost] Ошибка отправки решения:', err?.message);
      await bot.sendMessage(query.message!.chat.id, '❌ Ошибка при обработке. Попробуйте снова.');
    }
  }
});

// ─── Express: webhook от Railway ────────────────────────────────────────────

const expressApp = express();
expressApp.use(express.json());

// Получить заявку от Railway
expressApp.post('/bot/application', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });

  const app = req.body;
  if (!app || !app.id) return res.status(400).json({ error: 'Нет данных заявки' });

  const typeLabel = app.type === 'curator' ? '👑 Заявка на куратора' : app.type === 'moderator' ? '🛡️ Заявка на модератора' : '🎮 Заявка на вступление';
  const date = new Date(app.submitted_at || Date.now()).toLocaleString('ru-RU');

  let text = `${typeLabel} *#${app.id}*\n\n`;
  text += `👤 Discord: ${app.username || '—'}\n`;
  text += `🎂 Возраст: ${app.age || '—'} лет\n`;
  text += `📛 Имя: ${app.name || '—'}\n`;
  text += `⏱ Активность: ${app.activity || '—'}\n`;
  text += `🎯 Игры: ${app.games || '—'}\n`;
  text += `✅ Правила: ${app.rules ? 'Принимает' : 'Не принимает'}\n`;
  if (app.type === 'curator') {
    text += `\n📋 Опыт: ${app.experience || '—'}\n`;
    text += `💬 Мотивация: ${app.motivation || '—'}\n`;
  }
  text += `\n📅 Подано: ${date}`;

  try {
    const sentMsg = await bot.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Принять', callback_data: `approve_${app.id}` },
          { text: '❌ Отклонить', callback_data: `reject_${app.id}` },
        ]]
      }
    });
    console.log(`[BotHost] Заявка #${app.id} отправлена в Telegram, msg_id: ${sentMsg.message_id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[BotHost] Ошибка отправки в Telegram:', err?.message);
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

// Получить обновление сессии от Railway (после OAuth2)
expressApp.post('/bot/session', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { telegram_user_id, discord_username, discord_user_id, is_moderator } = req.body;
  if (!telegram_user_id) return res.status(400).json({ error: 'Нет telegram_user_id' });

  modSessions.set(Number(telegram_user_id), {
    discordUsername: discord_username,
    discordUserId: discord_user_id,
    isModerator: is_moderator,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  const statusMsg = is_moderator
    ? `✅ Авторизация успешна! Вы вошли как ${discord_username}.\n🛡️ Статус модератора подтверждён.`
    : `✅ Авторизация успешна! Вы вошли как ${discord_username}.\n⚠️ Роль модератора не обнаружена на сервере.`;

  try {
    await bot.sendMessage(Number(telegram_user_id), statusMsg);
  } catch {}

  res.json({ success: true });
});

expressApp.get('/healthz', (_req, res) => res.json({ status: 'ok', bot: 'polling' }));

expressApp.listen(PORT, () => {
  console.log(`[BotHost] Express запущен на порту ${PORT}`);
});
