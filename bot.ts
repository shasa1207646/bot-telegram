import TelegramBot from 'node-telegram-bot-api';
import { Client, GatewayIntentBits, Guild, GuildMember, VoiceChannel, StageChannel } from 'discord.js';
import * as nodePath from 'path';
// Прописываем ffmpeg в PATH чтобы @discordjs/voice его нашёл
import ffmpegPath from 'ffmpeg-static';
if (ffmpegPath) {
  process.env.PATH = `${nodePath.dirname(ffmpegPath)}:${process.env.PATH || ''}`;
}
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  StreamType,
} from '@discordjs/voice';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

// Явно регистрируем opusscript
try {
  const { createRequire } = require('module');
  const req = createRequire(__filename);
  const opusscript = req('opusscript');
  console.log('✅ opusscript загружен');
} catch (e) {
  console.error('❌ opusscript не найден:', e);
}

// Проверяем ffmpeg
console.log('ffmpeg path:', ffmpegPath);

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TG_TOKEN      = process.env.TG_BOT_TOKEN!;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID      = process.env.DISCORD_GUILD_ID!;

const ALLOWED_TG_IDS: number[] = (process.env.TG_ALLOWED_IDS || '')
  .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

// ─── ЗВУКИ ─────────────────────────────────────────────────────────────────
const SOUNDS: Record<string, { file: string; label: string }> = {
  tiki:   { file: 'tiki.mp3',   label: '🎵 Тики-тики' },
  gazan1: { file: 'gazan1.mp3', label: '💥 Газан 1' },
  gazan2: { file: 'gazan2.mp3', label: '💥 Газан 2' },
  gudok:  { file: 'gudok.mp3',  label: '🚂 Гудок паровоза' },
};

// ─── DISCORD CLIENT ────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let guild: Guild | null = null;

(discord as any).on('clientReady', async () => {
  console.log(`✅ Discord бот запущен как ${discord.user?.tag}`);
  guild = await discord.guilds.fetch(GUILD_ID) as Guild;
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

async function getGuild(): Promise<Guild | null> {
  if (guild) return guild;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (guild) return guild;
  }
  return null;
}

// ─── ВОСПРОИЗВЕДЕНИЕ ЗВУКА ─────────────────────────────────────────────────
async function playSound(
  chatId: number,
  voiceChannelId: string,
  soundKey: string,
  callbackQueryId?: string,
) {
  const g = await getGuild();
  if (!g) {
    tg.sendMessage(chatId, '❌ Discord не подключён.');
    return;
  }

  const sound = SOUNDS[soundKey];
  if (!sound) {
    tg.sendMessage(chatId, '❌ Звук не найден.');
    return;
  }

  const channel = g.channels.cache.get(voiceChannelId);
  if (!channel || !channel.isVoiceBased()) {
    tg.sendMessage(chatId, '❌ Голосовой канал не найден.');
    return;
  }

  // Уничтожаем старое соединение если есть
  const existing = getVoiceConnection(GUILD_ID);
  if (existing) existing.destroy();

  const soundPath = path.join(process.cwd(), 'sounds', sound.file);

  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId: GUILD_ID,
    adapterCreator: g.voiceAdapterCreator,
    selfDeaf: false,
  });

  const player = createAudioPlayer();

  connection.on(VoiceConnectionStatus.Ready, () => {
    try {
      const resource = createAudioResource(soundPath, { inputType: StreamType.Arbitrary, inlineVolume: false });
      connection.subscribe(player);
      player.play(resource);
    } catch (err: any) {
      console.error('Play error:', err);
      tg.sendMessage(chatId, `❌ Ошибка воспроизведения: ${err?.message}`);
      connection.destroy();
    }
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    try { connection.destroy(); } catch {}
  });

  player.on(AudioPlayerStatus.Idle, () => {
    connection.destroy();
  });

  player.on('error', (err) => {
    console.error('Player error:', err);
    connection.destroy();
  });

  if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: `▶️ Играет: ${sound.label}` });
  tg.sendMessage(chatId, `▶️ Играет ${sound.label} в канале ${channel.name}`);
}

// ─── /start ────────────────────────────────────────────────────────────────
tg.onText(/\/start/, async (msg) => {
  if (!checkAccess(msg)) return;
  tg.sendMessage(msg.chat.id,
    '👋 Petushara Voice Manager\n\n' +
    'Команды:\n' +
    '/voice — список людей в войсе + управление\n' +
    '/sounds — сыграть звук в войс-канале\n' +
    '/kick @username — кикнуть из войса\n' +
    '/mute @username — замутить микрофон\n' +
    '/unmute @username — снять мут\n' +
    '/deafen @username — выключить звук\n' +
    '/undeafen @username — включить звук\n' +
    '/all_mute — замутить всех\n' +
    '/all_unmute — снять мут у всех'
  );
});

// ─── /sounds — выбор звука и канала ───────────────────────────────────────
tg.onText(/\/sounds/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  // Показываем войс-каналы где есть люди
  const activeChannels: { id: string; name: string; count: number }[] = [];
  g.channels.cache.forEach(ch => {
    if (ch.isVoiceBased()) {
      const vc = ch as any;
      const humans = vc.members?.filter((m: GuildMember) => !m.user.bot).size || 0;
      if (humans > 0) activeChannels.push({ id: ch.id, name: ch.name, count: humans });
    }
  });

  if (activeChannels.length === 0) {
    return tg.sendMessage(msg.chat.id, '🔇 Нет активных войс-каналов.');
  }

  const keyboard = activeChannels.map(ch => ([{
    text: `🔊 ${ch.name} (${ch.count} чел.)`,
    callback_data: `sounds_ch:${ch.id}`,
  }]));

  tg.sendMessage(msg.chat.id, '🔊 Выбери канал для воспроизведения:', {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ─── /voice — список участников ───────────────────────────────────────────
tg.onText(/\/voice/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

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

// ─── CALLBACK QUERY ────────────────────────────────────────────────────────
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

  // Выбор канала для звука → показываем список звуков
  if (query.data.startsWith('sounds_ch:')) {
    const channelId = query.data.split(':')[1];
    const ch = g.channels.cache.get(channelId);

    const soundButtons = Object.entries(SOUNDS).map(([key, s]) => ([{
      text: s.label,
      callback_data: `play:${channelId}:${key}`,
    }]));
    soundButtons.push([{ text: '◀️ Назад', callback_data: 'sounds_back' }]);

    await tg.editMessageText(
      `🔊 Канал: ${ch?.name}\nВыбери звук:`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: soundButtons },
      }
    );
    tg.answerCallbackQuery(query.id);
  }

  // Воспроизвести звук
  if (query.data.startsWith('play:')) {
    const [, channelId, soundKey] = query.data.split(':');
    tg.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
    await playSound(query.message.chat.id, channelId, soundKey, query.id);
  }

  // Назад к выбору канала
  if (query.data === 'sounds_back') {
    tg.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
    tg.sendMessage(query.message.chat.id, 'Используй /sounds чтобы снова открыть.');
    tg.answerCallbackQuery(query.id);
  }

  // Выбор участника для управления
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

// ─── Текстовые команды ─────────────────────────────────────────────────────
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
  const member = await findMemberByUsername(match[2].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[2]} не найден.`);
  await handleVoiceAction(msg.chat.id, match[1], member.user.id);
});

tg.onText(/\/all_mute/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');
  await g.members.fetch();
  let count = 0;
  for (const [, member] of g.members.cache) {
    if (member.voice.channel && !member.user.bot) {
      await member.voice.setMute(true).catch(() => {});
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
      await member.voice.setMute(false).catch(() => {});
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
        if (!member.voice.channel) { tg.sendMessage(chatId, `⚠️ ${name} не в войсе.`); break; }
        await member.voice.disconnect('Kicked via Telegram');
        tg.sendMessage(chatId, `👢 ${name} кикнут из войса.`);
        break;
      case 'mute':
        await member.voice.setMute(true);
        tg.sendMessage(chatId, `🔇 Микрофон ${name} заглушён.`);
        break;
      case 'unmute':
        await member.voice.setMute(false);
        tg.sendMessage(chatId, `🎙 Мут с ${name} снят.`);
        break;
      case 'deafen':
        await member.voice.setDeaf(true);
        tg.sendMessage(chatId, `🔕 Звук ${name} выключен.`);
        break;
      case 'undeafen':
        await member.voice.setDeaf(false);
        tg.sendMessage(chatId, `🔊 Звук ${name} включён.`);
        break;
      default:
        tg.sendMessage(chatId, '❌ Неизвестное действие.');
    }
    if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: '✅ Готово' });
  } catch (err: any) {
    console.error(err);
    tg.sendMessage(chatId, `❌ Ошибка: ${err?.message}`);
    if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: '❌ Ошибка' });
  }
}

console.log('🤖 Telegram бот запускается...');
