import {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ButtonInteraction, ChatInputCommandInteraction, ColorResolvable
} from 'discord.js';
import { containsBadWord } from './badwords';
import { handleCommand } from './commands';
import pool from '../db/pool';

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

discordClient.once('ready', async () => {
  console.log(`[Discord] Бот запущен как ${discordClient.user?.tag}`);
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    try {
      const guild = await discordClient.guilds.fetch(guildId);
      console.log(`[Discord] Сервер загружен: ${guild.name} (${guild.memberCount} участников)`);
    } catch (err) {
      console.error('[Discord] Ошибка загрузки кэша участников:', err);
    }
  }
});

// Фильтр сообщений
discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (containsBadWord(message.content)) {
    try {
      await message.delete();
      const warn = await message.channel.send(`⚠️ <@${message.author.id}>, нецензурная лексика запрещена!`);
      setTimeout(() => warn.delete().catch(() => {}), 5000);
    } catch {}
  }
});

// Slash-команды
discordClient.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction as ChatInputCommandInteraction);
  }

  // Кнопки заявок
  if (interaction.isButton()) {
    const btn = interaction as ButtonInteraction;
    const [action, appId] = btn.customId.split('_');

    if (action !== 'approve' && action !== 'reject') return;

    // Проверить права пользователя (должен иметь ManageRoles или быть модератором)
    if (!btn.memberPermissions?.has('ManageRoles' as any)) {
      return btn.reply({ content: '❌ У вас нет прав для этого действия.', ephemeral: true });
    }

    await btn.deferReply({ ephemeral: true });

    try {
      const result = await pool.query('SELECT * FROM applications WHERE id = $1', [appId]);
      const app = result.rows[0];
      if (!app) return btn.editReply('❌ Заявка не найдена.');
      if (app.status !== 'pending') return btn.editReply('⚠️ Заявка уже обработана.');

      const guild = btn.guild!;

      if (action === 'approve') {
        // Найти или создать роль "Обзвон"
        let role = guild.roles.cache.find(r => r.name === 'Обзвон');
        if (!role) {
          role = await guild.roles.create({ name: 'Обзвон', color: '#57f287' as ColorResolvable });
        }
        try {
          const member = await guild.members.fetch(app.discord_id);
          await member.roles.add(role);
          const voiceLink = `https://discord.com/channels/${guild.id}/${process.env.DISCORD_VOICE_CHANNEL_ID}`;
          await member.send(`✅ Ваша заявка одобрена! Добро пожаловать на сервер.\n🎙️ Голосовой канал: ${voiceLink}`);
        } catch {}

        await pool.query(
          `UPDATE applications SET status='approved', decided_by=$1 WHERE id=$2`,
          [btn.user.username, appId]
        );
        await btn.editReply('✅ Заявка принята, роль выдана.');
      } else {
        try {
          const member = await guild.members.fetch(app.discord_id);
          await member.send('❌ Ваша заявка отклонена. Вы можете подать повторно позже.');
        } catch {}

        await pool.query(
          `UPDATE applications SET status='rejected', decided_by=$1 WHERE id=$2`,
          [btn.user.username, appId]
        );
        await btn.editReply('❌ Заявка отклонена.');
      }

      // Обновить embed (убрать кнопки)
      const statusText = action === 'approve' ? '✅ Принята' : '❌ Отклонена';
      const originalEmbed = btn.message.embeds[0];
      if (originalEmbed) {
        const updated = EmbedBuilder.from(originalEmbed)
          .setFooter({ text: `${statusText} — ${btn.user.username}` })
          .setColor(action === 'approve' ? '#57f287' as ColorResolvable : '#ff4444' as ColorResolvable);
        await btn.message.edit({ embeds: [updated], components: [] });
      }
    } catch (err) {
      console.error('[Discord] Ошибка обработки кнопки:', err);
      await btn.editReply('❌ Произошла ошибка.');
    }
  }
});

export async function sendApplicationToDiscord(app: any) {
  const channelId = process.env.DISCORD_CHANNEL_ID!;
  try {
    const channel = await discordClient.channels.fetch(channelId) as any;
    if (!channel) return;

    const typeLabel = app.type === 'curator' ? '👑 Заявка на куратора' : app.type === 'moderator' ? '🛡️ Заявка на модератора' : '🎮 Заявка на вступление';
    const embed = new EmbedBuilder()
      .setTitle(`${typeLabel} #${app.id}`)
      .setColor('#7c3aed' as ColorResolvable)
      .setThumbnail(app.discord_avatar || null)
      .addFields(
        { name: '👤 Discord', value: app.username || 'Неизвестно', inline: true },
        { name: '🎂 Возраст', value: String(app.age || '—'), inline: true },
        { name: '📛 Имя', value: app.name || '—', inline: true },
        { name: '⏱ Активность', value: app.activity || '—', inline: true },
        { name: '🎯 Игры', value: app.games || '—', inline: true },
        { name: '✅ Правила', value: app.rules ? 'Принимает' : 'Не принимает', inline: true },
      )
      .setTimestamp();

    if (app.type === 'curator') {
      embed.addFields(
        { name: '📋 Опыт', value: app.experience || '—', inline: false },
        { name: '💬 Мотивация', value: app.motivation || '—', inline: false },
      );
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${app.id}`)
        .setLabel('✅ Принять')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_${app.id}`)
        .setLabel('❌ Отклонить')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('[Discord] Ошибка отправки заявки:', err);
  }
}

export function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[Discord] DISCORD_BOT_TOKEN не задан, бот не запущен');
    return;
  }
  discordClient.login(token).catch(err => console.error('[Discord] Ошибка входа:', err));
}
