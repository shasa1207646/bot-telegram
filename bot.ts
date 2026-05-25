import TelegramBot from 'node-telegram-bot-api';
import {
  Client,
  GatewayIntentBits,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  ChannelType,
  VoiceChannel,
  StageChannel,
  Role,
} from 'discord.js';
import * as nodePath from 'path';

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
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

// ─── opusscript ──────────────────────────────────────────────────────────────
try {
  const { createRequire } = require('module');
  const req = createRequire(__filename);
  req('opusscript');
  console.log('✅ opusscript загружен');
} catch (e) {
  console.error('❌ opusscript не найден:', e);
}

console.log('ffmpeg path:', ffmpegPath);

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TG_TOKEN      = process.env.TG_BOT_TOKEN!;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID      = process.env.DISCORD_GUILD_ID!;

const ALLOWED_TG_IDS: number[] = (process.env.TG_ALLOWED_IDS || '')
  .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

// ─── ЗВУКИ ───────────────────────────────────────────────────────────────────
const SOUNDS: Record<string, { file: string; label: string }> = {
  tiki:   { file: 'tiki.mp3',   label: '🎵 Тики-тики' },
  gazan1: { file: 'gazan1.mp3', label: '💥 Газан 1' },
  gazan2: { file: 'gazan2.mp3', label: '💥 Газан 2' },
  gudok:  { file: 'gudok.mp3',  label: '🚂 Гудок паровоза' },
};

// ─── УНИЗИТЕЛЬНЫЕ РОЛИ ───────────────────────────────────────────────────────
const SHAME_ROLES = [
  '🐓 петух дня',
  '🤡 клоун сервера',
  '🐷 хрюша',
  '🦆 утёнок',
  '🍌 банановый король',
  '🧻 туалетная бумага',
  '🐌 улитка',
  '💩 какашка дня',
];

// ─── СМЕШНЫЕ НАЗВАНИЯ ДЛЯ КАНАЛОВ ───────────────────────────────────────────
const FUNNY_NAMES = [
  '💩 Туалет для умников',
  '🐓 Курятник',
  '🤡 Цирк на выезде',
  '🦆 Утиная ферма',
  '🧻 Туалет сломан',
  '📞 Звонок от мамы',
  '🥔 Картофелехранилище',
  '🚽 Переговорная #2',
  '🪤 Мышеловка',
  '🎪 Балаган',
  '🐸 Болото',
  '🍌 Банановая республика',
];

// ─── АКТИВНЫЕ BOUNCE-ЗАДАЧИ (move) ───────────────────────────────────────────
const activeBounces: Map<string, NodeJS.Timeout> = new Map();

// ─── DISCORD CLIENT ───────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let guild: Guild | null = null;
let lastMemberFetch = 0;

async function fetchMembersIfNeeded(g: Guild) {
  const now = Date.now();
  if (now - lastMemberFetch > 5 * 60 * 1000) {
    await g.members.fetch();
    lastMemberFetch = now;
  }
}

(discord as any).on('clientReady', async () => {
  console.log(`✅ Discord бот запущен как ${discord.user?.tag}`);
  guild = await discord.guilds.fetch(GUILD_ID) as Guild;
  await guild.channels.fetch();
  console.log(`✅ Сервер: ${guild.name}`);
});

discord.login(DISCORD_TOKEN);

// ─── TELEGRAM BOT ─────────────────────────────────────────────────────────────
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

async function findMemberByUsername(username: string): Promise<GuildMember | null> {
  const g = await getGuild();
  if (!g) return null;
  await fetchMembersIfNeeded(g);
  const clean = username.replace('@', '').toLowerCase();
  return g.members.cache.find(m =>
    m.user.username.toLowerCase() === clean ||
    m.displayName.toLowerCase() === clean
  ) || null;
}

// ─── ВОСПРОИЗВЕДЕНИЕ ЗВУКА ────────────────────────────────────────────────────
async function playSound(
  chatId: number,
  voiceChannelId: string,
  soundKey: string,
  callbackQueryId?: string,
) {
  const g = await getGuild();
  if (!g) return tg.sendMessage(chatId, '❌ Discord не подключён.');

  const sound = SOUNDS[soundKey];
  if (!sound) return tg.sendMessage(chatId, '❌ Звук не найден.');

  const channel = g.channels.cache.get(voiceChannelId);
  if (!channel || !channel.isVoiceBased()) return tg.sendMessage(chatId, '❌ Голосовой канал не найден.');

  const existing = getVoiceConnection(GUILD_ID);
  if (existing) existing.destroy();

  const soundPath = path.join(process.cwd(), 'sounds', sound.file);
  const fs = require('fs');
  console.log(`📁 soundPath: ${soundPath}, exists: ${fs.existsSync(soundPath)}`);

  const player = createAudioPlayer();
  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId: GUILD_ID,
    adapterCreator: g.voiceAdapterCreator,
    selfDeaf: true,
  });

  const startPlaying = () => {
    try {
      const resource = createAudioResource(soundPath, { inlineVolume: false });
      connection.subscribe(player);
      player.play(resource);
    } catch (err: any) {
      console.error('❌ Play error:', err);
      tg.sendMessage(chatId, `❌ Ошибка воспроизведения: ${err?.message}`);
      connection.destroy();
    }
  };

  connection.on('stateChange', async (oldState: any, newState: any) => {
    if (
      oldState.status !== VoiceConnectionStatus.Ready &&
      (newState.status === VoiceConnectionStatus.Connecting ||
       newState.status === VoiceConnectionStatus.Signalling)
    ) {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Ready, 7_000),
          entersState(connection, VoiceConnectionStatus.Disconnected, 7_000),
        ]);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          tg.sendMessage(chatId, '❌ Не удалось подключиться (таймаут).');
          connection.destroy();
        }
      }
    }
  });

  connection.once(VoiceConnectionStatus.Ready, () => startPlaying());
  connection.on(VoiceConnectionStatus.Disconnected, () => { try { connection.destroy(); } catch {} });
  player.on(AudioPlayerStatus.Idle, () => connection.destroy());
  player.on('error', (err) => { console.error('❌ Player error:', err); connection.destroy(); });

  if (callbackQueryId) tg.answerCallbackQuery(callbackQueryId, { text: `▶️ Играет: ${sound.label}` });
  tg.sendMessage(chatId, `▶️ Играет ${sound.label} в канале ${channel.name}`);
}

// ─── ОСНОВНАЯ ФУНКЦИЯ ДЕЙСТВИЙ С ВОЙСОМ ──────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════════
// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// /start
tg.onText(/\/start/, async (msg) => {
  if (!checkAccess(msg)) return;
  tg.sendMessage(msg.chat.id,
    '👋 *Petushara Voice Manager* — МАКСИМАЛЬНАЯ ВЕРСИЯ\n\n' +
    '🎧 *Войс:*\n' +
    '/voice — список людей в войсе + управление\n' +
    '/kick @user — кикнуть из войса\n' +
    '/mute @user — заглушить микрофон\n' +
    '/unmute @user — снять мут\n' +
    '/deafen @user — выключить звук\n' +
    '/undeafen @user — включить звук\n' +
    '/all\\_mute — замутить всех\n' +
    '/all\\_unmute — снять мут у всех\n\n' +
    '🏃 *Издевательства:*\n' +
    '/move @user — прыгать по каналам каждые 3 сек (остановить: /stop\\_move @user)\n' +
    '/stop\\_move @user — остановить прыганье\n' +
    '/rename\\_channel — переименовать войс-канал на смешное название\n\n' +
    '👑 *Роли и сервер:*\n' +
    '/role\\_add @user — выдать унизительную роль\n' +
    '/role\\_remove @user — забрать все неосновные роли\n' +
    '/nickname @user текст — сменить никнейм\n\n' +
    '💬 *Сообщения:*\n' +
    '/slowmode #канал секунды — включить slowmode\n' +
    '/ghost @user — сделать невидимым (роль без доступа к каналам)\n' +
    '/unghost @user — вернуть из призраков\n\n' +
    '🔊 *Звуки:*\n' +
    '/sounds — сыграть звук в войс-канале',
    { parse_mode: 'Markdown' }
  );
});

// ─── /sounds ──────────────────────────────────────────────────────────────────
tg.onText(/\/sounds/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const activeChannels: { id: string; name: string; count: number }[] = [];
  g.channels.cache.forEach(ch => {
    if (ch.isVoiceBased()) {
      const vc = ch as any;
      const humans = vc.members?.filter((m: GuildMember) => !m.user.bot).size || 0;
      if (humans > 0) activeChannels.push({ id: ch.id, name: ch.name, count: humans });
    }
  });

  if (activeChannels.length === 0) return tg.sendMessage(msg.chat.id, '🔇 Нет активных войс-каналов.');

  const keyboard = activeChannels.map(ch => ([{
    text: `🔊 ${ch.name} (${ch.count} чел.)`,
    callback_data: `sounds_ch:${ch.id}`,
  }]));

  tg.sendMessage(msg.chat.id, '🔊 Выбери канал для воспроизведения:', {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ─── /voice ───────────────────────────────────────────────────────────────────
tg.onText(/\/voice/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  await fetchMembersIfNeeded(g);
  const voiceMembers: { channel: string; member: GuildMember }[] = [];

  g.channels.cache.forEach(ch => {
    if (ch.isVoiceBased()) {
      const vc = ch as any;
      vc.members?.forEach((m: GuildMember) => {
        if (!m.user.bot) voiceMembers.push({ channel: ch.name, member: m });
      });
    }
  });

  if (voiceMembers.length === 0) return tg.sendMessage(msg.chat.id, '🔇 Никого нет в войс-каналах.');

  const lines = voiceMembers.map(({ channel, member }) => {
    const muted   = member.voice.serverMute ? '🔇' : '🎙';
    const deafend = member.voice.serverDeaf ? '🔕' : '🔊';
    return `${muted}${deafend} ${member.user.username} — ${channel}`;
  });

  const keyboard = voiceMembers.map(({ member }) => ([{
    text: member.user.username,
    callback_data: `select:${member.user.id}`,
  }]));

  tg.sendMessage(msg.chat.id,
    `🎧 Участники в войсе:\n\n${lines.join('\n')}\n\nНажми на участника для управления:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
});

// ─── /move @user ──────────────────────────────────────────────────────────────
tg.onText(/\/move (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);
  if (!member.voice.channel) return tg.sendMessage(msg.chat.id, `⚠️ ${member.user.username} не в войсе.`);

  const g = await getGuild();
  if (!g) return;

  const key = member.user.id;
  if (activeBounces.has(key)) {
    return tg.sendMessage(msg.chat.id, `⚠️ ${member.user.username} уже прыгает! Останови через /stop_move @${member.user.username}`);
  }

  tg.sendMessage(msg.chat.id, `🏃 ${member.user.username} начинает прыгать по каналам! /stop_move @${member.user.username} чтобы остановить.`);

  const interval = setInterval(async () => {
    try {
      const freshMember = await g.members.fetch(key).catch(() => null);
      if (!freshMember || !freshMember.voice.channel) {
        clearInterval(interval);
        activeBounces.delete(key);
        return;
      }

      const voiceChannels = g.channels.cache.filter(ch =>
        ch.type === ChannelType.GuildVoice && ch.id !== freshMember.voice.channelId
      );

      if (voiceChannels.size === 0) return;

      const channels = [...voiceChannels.values()];
      const randomChannel = channels[Math.floor(Math.random() * channels.length)] as VoiceChannel;
      await freshMember.voice.setChannel(randomChannel).catch(() => {});
    } catch {
      clearInterval(interval);
      activeBounces.delete(key);
    }
  }, 3000);

  activeBounces.set(key, interval);
});

// ─── /stop_move @user ─────────────────────────────────────────────────────────
tg.onText(/\/stop_move (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);

  const key = member.user.id;
  const timer = activeBounces.get(key);
  if (!timer) return tg.sendMessage(msg.chat.id, `⚠️ ${member.user.username} не прыгает.`);

  clearInterval(timer);
  activeBounces.delete(key);
  tg.sendMessage(msg.chat.id, `🛑 ${member.user.username} остановлен.`);
});

// ─── /rename_channel ──────────────────────────────────────────────────────────
tg.onText(/\/rename_channel/, async (msg) => {
  if (!checkAccess(msg)) return;
  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const activeChannels: { id: string; name: string; count: number }[] = [];
  g.channels.cache.forEach(ch => {
    if (ch.isVoiceBased()) {
      const vc = ch as any;
      const humans = vc.members?.filter((m: GuildMember) => !m.user.bot).size || 0;
      if (humans > 0) activeChannels.push({ id: ch.id, name: ch.name, count: humans });
    }
  });

  if (activeChannels.length === 0) return tg.sendMessage(msg.chat.id, '🔇 Нет активных войс-каналов с людьми.');

  const keyboard = activeChannels.map(ch => ([{
    text: `🔊 ${ch.name} (${ch.count} чел.)`,
    callback_data: `rename_ch:${ch.id}`,
  }]));

  tg.sendMessage(msg.chat.id, '🔤 Выбери канал для переименования:', {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// ─── /role_add @user ──────────────────────────────────────────────────────────
tg.onText(/\/role_add (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);

  const roleName = SHAME_ROLES[Math.floor(Math.random() * SHAME_ROLES.length)];

  // Ищем роль или создаём
  let role = g.roles.cache.find(r => r.name === roleName);
  if (!role) {
    try {
      role = await g.roles.create({
        name: roleName,
        color: 0xff4444,
        reason: 'Унизительная роль от Telegram',
      });
    } catch (err: any) {
      return tg.sendMessage(msg.chat.id, `❌ Не удалось создать роль: ${err?.message}`);
    }
  }

  try {
    await member.roles.add(role);
    tg.sendMessage(msg.chat.id, `👑 ${member.user.username} получил роль: ${roleName}`);
  } catch (err: any) {
    tg.sendMessage(msg.chat.id, `❌ Ошибка: ${err?.message}`);
  }
});

// ─── /role_remove @user ───────────────────────────────────────────────────────
tg.onText(/\/role_remove (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);

  try {
    // Убираем все управляемые роли кроме @everyone
    const removable = member.roles.cache.filter(r =>
      r.id !== g.id && r.managed === false
    );
    await member.roles.remove(removable);
    tg.sendMessage(msg.chat.id, `🗑 У ${member.user.username} забрано ${removable.size} ролей.`);
  } catch (err: any) {
    tg.sendMessage(msg.chat.id, `❌ Ошибка: ${err?.message}`);
  }
});

// ─── /nickname @user текст ────────────────────────────────────────────────────
tg.onText(/\/nickname (@\S+|\S+) (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);

  const newNick = match[2].trim().slice(0, 32); // Discord limit

  try {
    await member.setNickname(newNick, 'Changed via Telegram');
    tg.sendMessage(msg.chat.id, `✏️ Никнейм ${member.user.username} изменён на: ${newNick}`);
  } catch (err: any) {
    tg.sendMessage(msg.chat.id, `❌ Ошибка: ${err?.message}`);
  }
});

// ─── /slowmode канал секунды ──────────────────────────────────────────────────
tg.onText(/\/slowmode (#?\S+) (\d+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const channelName = match[1].replace('#', '').toLowerCase();
  const seconds = Math.min(parseInt(match[2]), 21600); // Discord max 6h

  const channel = g.channels.cache.find(ch =>
    ch.name.toLowerCase() === channelName &&
    (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildForum)
  ) as any;

  if (!channel) return tg.sendMessage(msg.chat.id, `❌ Текстовый канал #${channelName} не найден.`);

  try {
    await channel.setRateLimitPerUser(seconds);
    tg.sendMessage(msg.chat.id,
      seconds === 0
        ? `✅ Slowmode в #${channel.name} выключен.`
        : `🐌 Slowmode в #${channel.name} установлен: ${seconds} сек.`
    );
  } catch (err: any) {
    tg.sendMessage(msg.chat.id, `❌ Ошибка: ${err?.message}`);
  }
});

// ─── /ghost @user ─────────────────────────────────────────────────────────────
tg.onText(/\/ghost (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);

  const ghostRoleName = '👻 Призрак';
  let ghostRole = g.roles.cache.find(r => r.name === ghostRoleName);

  if (!ghostRole) {
    try {
      // Создаём роль без права видеть каналы
      ghostRole = await g.roles.create({
        name: ghostRoleName,
        color: 0x36393f,
        permissions: [],
        reason: 'Ghost role from Telegram',
      });

      // Запрещаем видеть все текстовые каналы
      const textChannels = g.channels.cache.filter(ch =>
        ch.type === ChannelType.GuildText
      );
      for (const [, ch] of textChannels) {
        await (ch as any).permissionOverwrites.create(ghostRole, {
          ViewChannel: false,
        }).catch(() => {});
      }
    } catch (err: any) {
      return tg.sendMessage(msg.chat.id, `❌ Не удалось создать роль призрака: ${err?.message}`);
    }
  }

  try {
    await member.roles.add(ghostRole);
    // Кикаем из войса если там сидит
    if (member.voice.channel) await member.voice.disconnect().catch(() => {});
    tg.sendMessage(msg.chat.id, `👻 ${member.user.username} исчез с сервера!`);
  } catch (err: any) {
    tg.sendMessage(msg.chat.id, `❌ Ошибка: ${err?.message}`);
  }
});

// ─── /unghost @user ───────────────────────────────────────────────────────────
tg.onText(/\/unghost (.+)/, async (msg, match) => {
  if (!checkAccess(msg)) return;
  if (!match) return;

  const g = await getGuild();
  if (!g) return tg.sendMessage(msg.chat.id, '❌ Discord не подключён.');

  const member = await findMemberByUsername(match[1].trim());
  if (!member) return tg.sendMessage(msg.chat.id, `❌ Пользователь ${match[1]} не найден.`);

  const ghostRole = g.roles.cache.find(r => r.name === '👻 Призрак');
  if (!ghostRole) return tg.sendMessage(msg.chat.id, `⚠️ Роль призрака не найдена.`);

  try {
    await member.roles.remove(ghostRole);
    tg.sendMessage(msg.chat.id, `✅ ${member.user.username} возвращён из призраков!`);
  } catch (err: any) {
    tg.sendMessage(msg.chat.id, `❌ Ошибка: ${err?.message}`);
  }
});

// ─── Текстовые команды войс-действий ──────────────────────────────────────────
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
  await fetchMembersIfNeeded(g);
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
  await fetchMembersIfNeeded(g);
  let count = 0;
  for (const [, member] of g.members.cache) {
    if (member.voice.channel && !member.user.bot) {
      await member.voice.setMute(false).catch(() => {});
      count++;
    }
  }
  tg.sendMessage(msg.chat.id, `🎙 Мут снят у ${count} участников.`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CALLBACK QUERY ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
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

  const { data } = query;
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  // ── Выбор канала для звука
  if (data.startsWith('sounds_ch:')) {
    const channelId = data.split(':')[1];
    const ch = g.channels.cache.get(channelId);
    const soundButtons = Object.entries(SOUNDS).map(([key, s]) => ([{
      text: s.label,
      callback_data: `play:${channelId}:${key}`,
    }]));
    soundButtons.push([{ text: '◀️ Назад', callback_data: 'sounds_back' }]);
    await tg.editMessageText(`🔊 Канал: ${ch?.name}\nВыбери звук:`, {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: soundButtons },
    });
    tg.answerCallbackQuery(query.id);
    return;
  }

  // ── Воспроизвести звук
  if (data.startsWith('play:')) {
    const [, channelId, soundKey] = data.split(':');
    tg.deleteMessage(chatId, msgId).catch(() => {});
    await playSound(chatId, channelId, soundKey, query.id);
    return;
  }

  // ── Назад к звукам
  if (data === 'sounds_back') {
    tg.deleteMessage(chatId, msgId).catch(() => {});
    tg.sendMessage(chatId, 'Используй /sounds чтобы снова открыть.');
    tg.answerCallbackQuery(query.id);
    return;
  }

  // ── Выбор канала для переименования
  if (data.startsWith('rename_ch:')) {
    const channelId = data.split(':')[1];
    const ch = g.channels.cache.get(channelId);
    if (!ch) return tg.answerCallbackQuery(query.id, { text: '❌ Канал не найден' });

    const nameButtons = FUNNY_NAMES.map(name => ([{
      text: name,
      callback_data: `do_rename:${channelId}:${encodeURIComponent(name)}`,
    }]));
    nameButtons.push([{ text: '◀️ Назад', callback_data: 'sounds_back' }]);

    await tg.editMessageText(`🔤 Канал: ${ch.name}\nВыбери новое название:`, {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: nameButtons },
    });
    tg.answerCallbackQuery(query.id);
    return;
  }

  // ── Выполнить переименование
  if (data.startsWith('do_rename:')) {
    const parts = data.split(':');
    const channelId = parts[1];
    const newName   = decodeURIComponent(parts.slice(2).join(':'));
    const ch = g.channels.cache.get(channelId) as VoiceChannel;
    if (!ch) return tg.answerCallbackQuery(query.id, { text: '❌ Канал не найден' });

    try {
      await ch.setName(newName);
      tg.deleteMessage(chatId, msgId).catch(() => {});
      tg.sendMessage(chatId, `✅ Канал переименован в: ${newName}`);
      tg.answerCallbackQuery(query.id, { text: '✅ Переименовано!' });
    } catch (err: any) {
      tg.answerCallbackQuery(query.id, { text: `❌ ${err?.message}` });
    }
    return;
  }

  // ── Выбор участника для управления
  if (data.startsWith('select:')) {
    const discordId = data.split(':')[1];
    const member = await g.members.fetch(discordId).catch(() => null);
    if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Участник не найден' });

    const name   = member.user.username;
    const muted  = member.voice.serverMute ? '✅ замучен' : '❌ не замучен';
    const deafen = member.voice.serverDeaf ? '✅ оглушён' : '❌ не оглушён';

    await tg.editMessageText(
      `👤 ${name}\n\n🎙 Мут: ${muted}\n🔊 Деаф: ${deafen}\n\nВыбери действие:`,
      {
        chat_id: chatId,
        message_id: msgId,
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
            [
              { text: '🏃 Прыгать по каналам', callback_data: `action:bounce:${discordId}` },
              { text: '🛑 Стоп прыжки',         callback_data: `action:stopbounce:${discordId}` },
            ],
            [
              { text: '👑 Унизительная роль', callback_data: `action:shamerole:${discordId}` },
              { text: '🗑 Убрать все роли',    callback_data: `action:removeroles:${discordId}` },
            ],
            [
              { text: '👻 Призрак',         callback_data: `action:ghost:${discordId}` },
              { text: '✅ Вернуть призрака', callback_data: `action:unghost:${discordId}` },
            ],
            [{ text: '◀️ Назад к списку', callback_data: 'back' }],
          ],
        },
      }
    );
    tg.answerCallbackQuery(query.id);
    return;
  }

  // ── Действия
  if (data.startsWith('action:')) {
    const parts = data.split(':');
    const action = parts[1];
    const discordId = parts[2];

    if (action === 'bounce') {
      const member = await g.members.fetch(discordId).catch(() => null);
      if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Участник не найден' });
      if (!member.voice.channel) return tg.answerCallbackQuery(query.id, { text: '⚠️ Не в войсе' });

      if (activeBounces.has(discordId)) {
        return tg.answerCallbackQuery(query.id, { text: '⚠️ Уже прыгает!' });
      }

      tg.answerCallbackQuery(query.id, { text: '🏃 Начинаем прыжки!' });
      tg.sendMessage(chatId, `🏃 ${member.user.username} начинает прыгать!`);

      const interval = setInterval(async () => {
        try {
          const fm = await g.members.fetch(discordId).catch(() => null);
          if (!fm || !fm.voice.channel) { clearInterval(interval); activeBounces.delete(discordId); return; }
          const channels = g.channels.cache.filter(ch => ch.type === ChannelType.GuildVoice && ch.id !== fm.voice.channelId);
          if (channels.size === 0) return;
          const arr = [...channels.values()];
          const rand = arr[Math.floor(Math.random() * arr.length)] as VoiceChannel;
          await fm.voice.setChannel(rand).catch(() => {});
        } catch { clearInterval(interval); activeBounces.delete(discordId); }
      }, 3000);
      activeBounces.set(discordId, interval);
      return;
    }

    if (action === 'stopbounce') {
      const timer = activeBounces.get(discordId);
      if (!timer) return tg.answerCallbackQuery(query.id, { text: '⚠️ Не прыгает' });
      clearInterval(timer);
      activeBounces.delete(discordId);
      tg.answerCallbackQuery(query.id, { text: '🛑 Остановлен' });
      return;
    }

    if (action === 'shamerole') {
      const member = await g.members.fetch(discordId).catch(() => null);
      if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Не найден' });
      const roleName = SHAME_ROLES[Math.floor(Math.random() * SHAME_ROLES.length)];
      let role = g.roles.cache.find(r => r.name === roleName);
      if (!role) {
        role = await g.roles.create({ name: roleName, color: 0xff4444, reason: 'Shame role' }).catch(() => undefined);
      }
      if (!role) return tg.answerCallbackQuery(query.id, { text: '❌ Ошибка создания роли' });
      await member.roles.add(role).catch(() => {});
      tg.answerCallbackQuery(query.id, { text: `👑 Выдана роль: ${roleName}` });
      tg.sendMessage(chatId, `👑 ${member.user.username} получил роль: ${roleName}`);
      return;
    }

    if (action === 'removeroles') {
      const member = await g.members.fetch(discordId).catch(() => null);
      if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Не найден' });
      const removable = member.roles.cache.filter(r => r.id !== g.id && !r.managed);
      await member.roles.remove(removable).catch(() => {});
      tg.answerCallbackQuery(query.id, { text: `🗑 Убрано ${removable.size} ролей` });
      tg.sendMessage(chatId, `🗑 У ${member.user.username} убрано ${removable.size} ролей.`);
      return;
    }

    if (action === 'ghost') {
      const member = await g.members.fetch(discordId).catch(() => null);
      if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Не найден' });
      const ghostRoleName = '👻 Призрак';
      let ghostRole = g.roles.cache.find(r => r.name === ghostRoleName);
      if (!ghostRole) {
        ghostRole = await g.roles.create({ name: ghostRoleName, color: 0x36393f, permissions: [], reason: 'Ghost' }).catch(() => undefined);
        if (ghostRole) {
          const textChs = g.channels.cache.filter(ch => ch.type === ChannelType.GuildText);
          for (const [, ch] of textChs) {
            await (ch as any).permissionOverwrites.create(ghostRole!, { ViewChannel: false }).catch(() => {});
          }
        }
      }
      if (!ghostRole) return tg.answerCallbackQuery(query.id, { text: '❌ Ошибка роли' });
      await member.roles.add(ghostRole).catch(() => {});
      if (member.voice.channel) await member.voice.disconnect().catch(() => {});
      tg.answerCallbackQuery(query.id, { text: '👻 Призрак!' });
      tg.sendMessage(chatId, `👻 ${member.user.username} исчез с сервера!`);
      return;
    }

    if (action === 'unghost') {
      const member = await g.members.fetch(discordId).catch(() => null);
      if (!member) return tg.answerCallbackQuery(query.id, { text: '❌ Не найден' });
      const ghostRole = g.roles.cache.find(r => r.name === '👻 Призрак');
      if (!ghostRole) return tg.answerCallbackQuery(query.id, { text: '⚠️ Роль не найдена' });
      await member.roles.remove(ghostRole).catch(() => {});
      tg.answerCallbackQuery(query.id, { text: '✅ Возвращён!' });
      tg.sendMessage(chatId, `✅ ${member.user.username} возвращён из призраков!`);
      return;
    }

    await handleVoiceAction(chatId, action, discordId, query.id);
    return;
  }

  if (data === 'back') {
    tg.deleteMessage(chatId, msgId).catch(() => {});
    tg.sendMessage(chatId, 'Используй /voice чтобы снова открыть список.');
    tg.answerCallbackQuery(query.id);
  }
});

console.log('🤖 Petushara Voice Manager запускается...');
