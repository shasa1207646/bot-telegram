# 🎙 TG Voice Manager

Telegram бот для управления голосовыми каналами Discord прямо из Telegram.

## Что умеет

- 👢 **Кикнуть** участника из войс-канала
- 🔇 **Замутить микрофон** (server mute)
- 🎙 **Снять мут** микрофона
- 🔕 **Выключить звук** (server deafen)
- 🔊 **Включить звук**
- 🔇 **Замутить всех** в войсе одной командой
- 📋 **Список** всех участников в войсе с их статусом

## Установка

### 1. Создать Telegram бота

1. Открой [@BotFather](https://t.me/BotFather) в Telegram
2. Напиши `/newbot` и следуй инструкциям
3. Сохрани токен (выглядит как `1234567890:ABCdef...`)

### 2. Узнать свой Telegram ID

Напиши [@userinfobot](https://t.me/userinfobot) — он пришлёт твой ID.

### 3. Настроить Discord бота

1. Зайди на [discord.com/developers/applications](https://discord.com/developers/applications)
2. Создай приложение → Bot → скопируй токен
3. В **Bot settings** включи Privileged Intents:
   - ✅ `SERVER MEMBERS INTENT`
   - ✅ `GUILD VOICE STATES` (автоматически включён)
4. Добавь бота на сервер через OAuth2 с правами:
   - `Mute Members`
   - `Deafen Members`
   - `Move Members`

   Ссылка для добавления:
   ```
   https://discord.com/oauth2/authorize?client_id=ВАШ_CLIENT_ID&permissions=1100&scope=bot
   ```

### 4. Получить Guild ID (ID сервера)

В Discord: `Настройки → Расширенные → Режим разработчика ON`
Затем правая кнопка на сервере → **Копировать ID сервера**

### 5. Настроить .env

```bash
cp .env.example .env
```

Заполни `.env`:
```env
TG_BOT_TOKEN=твой_telegram_токен
TG_ALLOWED_IDS=твой_telegram_id
DISCORD_BOT_TOKEN=твой_discord_токен
DISCORD_GUILD_ID=id_твоего_сервера
```

### 6. Запуск

```bash
npm install

# Для разработки:
npm run dev

# Для продакшна:
npm run build
npm start
```

## Команды

| Команда | Описание |
|---|---|
| `/voice` | Список всех в войсе + кнопки управления |
| `/kick @username` | Кикнуть из войса |
| `/mute @username` | Замутить микрофон |
| `/unmute @username` | Снять мут микрофона |
| `/deafen @username` | Выключить звук |
| `/undeafen @username` | Включить звук |
| `/all_mute` | Замутить всех в войсе |
| `/all_unmute` | Снять мут у всех |

## Деплой на Railway

Этот бот можно запустить рядом с основным Petushara ботом на Railway:
1. Создай новый сервис
2. Подключи репозиторий
3. Добавь переменные окружения
4. В `railway.json` уже есть нужная конфигурация

```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": { "startCommand": "npm run build && npm start" }
}
```
