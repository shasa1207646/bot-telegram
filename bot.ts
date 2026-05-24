import TelegramBot from 'node-telegram-bot-api';
import { Client, GatewayIntentBits, Guild, GuildMember } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TG_TOKEN      = process.env.TG_BOT_TOKEN!;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID      = process.env.DISCORD_GUILD_ID!;

const ALLOWED_TG_IDS: number[] = (process.env.TG_ALLOWED_IDS || '')
  .split(',')
  .map(s => parseInt(s.trim()))
  .filter(n => !isNaN(n));

// ─── DISCORD CLIENT ────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let guild: Guild | null = null;

// Используем clientReady (новое название) + обратная совместимость
(discord as any).on('clientReady', async () => {
  console.log(`✅ Discord бот запущен как ${discord.user?.tag}`);
  guild = await discord.guilds.fetch(GUILD_ID) as Guild;
  // Форс-загружаем каналы и участников
  await guild.channels.fetch();
  await guild.members.fetch();
  console.log(`✅ Сервер: ${guild.name}`);
});

discord.login(DISCORD_TOKEN);

// ─── TELEGRAM BOT ──────────────────────────────────────────────────────────
const tg = new TelegramBot(TG_TOKEN, { polling: true });

function isAllowed(userId: number): boolean {
  return ALLOWED_TG_IDS.includes(userId);
}

function checkAccess(msg: TelegramBot.Message): boolean {
  if (!isAllowed(msg.from!.id)) {
    tg.sendMessage(msg.chat.id, '🚫 У тебя нет доступа к этому боту.');
    return false;
  }
  return true;
}

// Безопасное экранирование для MarkdownV2
function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function getGuild(): Promise<Guild | null> {
  if (guild) return guild;
  // Если ещё не загрузился — ждём до 5 секунд
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (guild) return guild;
  }
  return null;
}

// ─── /start ────────────────────────────────────────────────────────────────
tg.onText(/\/start/, async (msg) => {
  if (!checkAccess(msg)) return;
  tg.sendMessage(msg.chat.id,
    '👋 Petushara Voice Manager\n\n' +
    'Команды:\n' +
    '/voice — список людей в войсе\n' +
    '/kick @username — кикнуть из войса\n' +
    '/mute @username — замутить микрофон\n' +
    '/unmute @username — снять мут микрофона\n' +
    '/deafen @username — выключить звук\n' +
    '/undeafen @username — включить звук\n' +
    '/all_mute — замутить всех в войсе\n' +
    '/all_unmute — снять мут у всех'
  );
});

// ─── /voice — список участников ───────────────────────────────────────────
tg.onText(/\/voice/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord ещё не подключён, подожди пару секунд и попробуй снова.');

  await g.members.fetch();
  const voiceMembers: { channel: string; member: GuildMember }[] = [];

  g.channels.cache.forEach(ch => {
    if (ch.isVoiceBased()) {
      const vc = ch as any;
      vc.members?.forEach((m: GuildMember) => {
        if (!m.user.bot) voiceMembers.push({ channel: ch.name, member: m });
      });
    }
  });

  if (voiceMembers.length === 0) {
    return tg.sendMessage(msg.chat.id, '🔇 Никого нет в войс-каналах.');
  }

  // Без MarkdownV2 — просто plain text, безопаснее
  const lines = voiceMembers.map(({ channel, member }) => {
    const muted   = member.voice.serverMute ? '🔇' : '🎙';
    const deafend = member.voice.serverDeaf ? '🔕' : '🔊';
    return `${muted}${deafend} ${member.user.username} — ${channel}`;
  });

  const keyboard = voiceMembers.map(({ member }) => ([{
    text: member.user.username,
    callback_data: `select:${member.user.id}`,
  }]));

  await tg.sendMessage(msg.chat.id,
    `🎧 Участники в войсе:\n\n${lines.join('\n')}\n\nНажми на участника для управления:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
});

// ─── Выбор участника через кнопку ─────────────────────────────────────────
tg.on('callback_query', async (query) => {
  if (!query.data || !query.message) return;
  if (!isAllowed(query.from.id)) {
    return tg.answerCallbackQuery(query.id, { text: '🚫 Нет доступа' });
  }

  const g = await getGuild();
  if (!g) {
    tg.answerCallbackQuery(query.id, { text: '❌ Discord не подключён' });
    return;
  }

  if (query.data.startsWith('select:')) {
    const discordId = query.data.split(':')[1];
    const member = await g.members.fetch(discordId).catch(() => null);
    if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Участник не найден' });

    const name   = member.user.username;
    const muted  = member.voice.serverMute ? '✅ замучен' : '❌ не замучен';
    const deafen = member.voice.serverDeaf ? '✅ оглушён' : '❌ не оглушён';

    await tg.editMessageText(
      `👤 ${name}\n\n🎙 Мут: ${muted}\n🔊 Деаф: ${deafen}\n\nВыбери действие:`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '👢 Кикнуть из войса', callback_data: `action:kick:${discordId}` }],
            [
              { text: '🔇 Мут микрофона', callback_data: `action:mute:${discordId}` },
              { text: '🎙 Снять мут',      callback_data: `action:unmute:${discordId}` },
            ],
            [
              { text: '🔕 Выкл. звук',    callback_data: `action:deafen:${discordId}` },
              { text: '🔊 Вкл. звук',      callback_data: `action:undeafen:${discordId}` },
            ],
            [{ text: '◀️ Назад к списку', callback_data: 'back' }],
          ],
        },
      }
    );
    tg.answerCallbackQuery(query.id);
  }

  if (query.data.startsWith('action:')) {
    const [, action, discordId] = query.data.split(':');
    await handleVoiceAction(query.message.chat.id, action, discordId, query.id);
  }

  if (query.data === 'back') {
    tg.deleteMessage(query.message.chat.id, query.message.message_id);
    tg.sendMessage(query.message.chat.id, 'Используй /voice чтобы снова открыть список.');
    tg.answerCallbackQuery(query.id);
  }
});

// ─── Команды через текст ───────────────────────────────────────────────────
async function findMemberByUsername(username: string): Promise<GuildMember | null> {
  const g = await getGuild();
  if (!g) return null;
  await g.members.fetch();
  const clean = username.replace('@', '').toLowerCase();
  return g.members.cache.find(m =>
    m.user.username.toLowerCase() === clean ||
    m.displayName.toLowerCase() === clean
  ) || null;
}

tg.onText(/\/(kick|mute|unmute|deafen|undeafen) (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;
  const action   = match[1];
  const username = match[2].trim();
  const member   = await findMemberByUsername(username);
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${username} не найден на сервере.`);
  await handleVoiceAction(msg.chat.id, action, member.user.id);
});

// ─── /all_mute и /all_unmute ───────────────────────────────────────────────
tg.onText(/\/all_mute/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');
  await g.members.fetch();
  let count = 0;
  for (const [, member] of g.members.cache) {
    if (member.voice.channel && !member.user.bot) {
      await member.voice.setMute(true, 'Mass mute via Telegram').catch(() => {});
      count++;
    }
  }
  tg.sendMessage(msg.chat.id, `🔇 Замучено ${count} участников.`);
});

tg.onText(/\/all_unmute/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');
  await g.members.fetch();
  let count = 0;
  for (const [, member] of g.members.cache) {
    if (member.voice.channel && !member.user.bot) {
      await member.voice.setMute(false, 'Mass unmute via Telegram').catch(() => {});
      count++;
    }
  }
  tg.sendMessage(msg.chat.id, `🎙 Мут снят у ${count} участников.`);
});

// ─── Основная функция действий ─────────────────────────────────────────────
async function handleVoiceAction(
  chatId: number,
  action: string,
  discordId: string,
  callbackQueryId?: string,
) {
  const g = await getGuild();
  if (!g) return tg.sendMessage(chatId, '❌ Discord не подключён.');

  const member = await g.members.fetch(discordId).catch(() => null);
  if (!member) {
    tg.sendMessage(chatId, '❌ Участник не найден.');
    if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: '❌ Не найден' });
    return;
  }

  const name = member.user.username;

  try {
    switch (action) {
      case 'kick':
        if (!member.voice.channel) {
          tg.sendMessage(chatId, `⚠️ ${name} не в войсе.`);
          break;
        }
        await member.voice.disconnect('Kicked via Telegram');
        tg.sendMessage(chatId, `👢 ${name} кикнут из войса.`);
        break;
      case 'mute':
        await member.voice.setMute(true, 'Muted via Telegram');
        tg.sendMessage(chatId, `🔇 Микрофон ${name} заглушён.`);
        break;
      case 'unmute':
        await member.voice.setMute(false, 'Unmuted via Telegram');
        tg.sendMessage(chatId, `🎙 Мут с ${name} снят.`);
        break;
      case 'deafen':
        await member.voice.setDeaf(true, 'Deafened via Telegram');
        tg.sendMessage(chatId, `🔕 Звук ${name} выключен.`);
        break;
      case 'undeafen':
        await member.voice.setDeaf(false, 'Undeafened via Telegram');
        tg.sendMessage(chatId, `🔊 Звук ${name} включён.`);
        break;
      default:
        tg.sendMessage(chatId, '❌ Неизвестное действие.');
    }
    if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: '✅ Готово' });
  } catch (err: any) {
    console.error(err);
    tg.sendMessage(chatId, `❌ Ошибка: ${err?.message || 'неизвестная ошибка'}`);
    if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: '❌ Ошибка' });
  }
}

console.log('🤖 Telegram бот запускается...');
