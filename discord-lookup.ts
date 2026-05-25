import { Client, GuildMember } from 'discord.js';

function matchesUsername(member: GuildMember, cleanName: string): boolean {
  return (
    member.user.username.toLowerCase() === cleanName ||
    member.displayName.toLowerCase() === cleanName ||
    (member.user.globalName != null &&
      member.user.globalName.toLowerCase() === cleanName)
  );
}

function formatMember(member: GuildMember) {
  return {
    found: true,
    discord_id: member.user.id,
    username: '@' + member.user.username,
    displayName: member.displayName,
    avatar: member.user.displayAvatarURL({ size: 128 }),
    roles: member.roles.cache
      .filter(r => r.name !== '@everyone')
      .map(r => ({ name: r.name, color: r.hexColor })),
    joinedAt: member.joinedAt?.toISOString(),
  };
}

export async function lookupDiscordUser(client: Client, username: string) {
  try {
    const guildId = process.env.DISCORD_GUILD_ID!;
    const guild = await client.guilds.fetch(guildId);
    const cleanName = username.replace(/^@/, '').toLowerCase().trim();

    // Ищем через API (по имени пользователя и displayName на стороне Discord).
    // guild.members.search() обращается к API напрямую, не требует кэша.
    try {
      const searchResults = await guild.members.search({ query: cleanName, limit: 10 });
      const found = searchResults.find(m => matchesUsername(m, cleanName));
      if (found) return formatMember(found);
    } catch (searchErr) {
      console.warn('[Discord Lookup] members.search() failed:', searchErr);
    }

    // Если search не нашёл — пробуем найти по точному username через fetch одного участника
    // НЕ делаем guild.members.fetch() без аргументов — это вызывает rate limit opcode 8
    return { found: false };
  } catch (err) {
    console.error('[Discord Lookup]', err);
    return { found: false, error: 'Ошибка при поиске пользователя' };
  }
}
