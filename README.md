# Zuest 🤖

A Discord bot that completes **Discord Quests** on behalf of linked user accounts. Built with Node.js + discord.js, deployable to Railway.

> ⚠️ **ToS notice:** Using a user token to automate Discord is against Discord's Terms of Service. Use at your own risk. Zuest is for educational purposes and personal automation only.

## How it works

1. You invite **Zuest** (a normal Discord bot) to your server.
2. You DM the bot your **Discord user token** (not a bot token — bots have no access to the Quests API).
3. Zuest stores your token **AES-256 encrypted** in a SQLite database.
4. When you run `;quests`, `;quest`, or `;questall`, Zuest opens a **temporary Discord gateway connection** with your token to receive quest data (Discord doesn't expose a REST endpoint to list quests — the data is only pushed via WebSocket). After receiving the quest list, it disconnects and uses the REST API for actions (enroll, video-progress, heartbeats, claim).

Quest data is cached for 60 seconds after each fetch, so running `;quests` then `;questall` won't trigger two gateway connections.

The quest-completion logic is a server-side port of [nyxxbit/discord-quest-completer](https://github.com/nyxxbit/discord-quest-completer) (a browser userscript). Because the bot runs server-side (no Discord desktop client to patch), some quest types can't be auto-completed:

| Quest type   | Support | Notes |
|--------------|---------|-------|
| VIDEO        | ✅ Full | POST `/quests/{id}/video-progress` in a loop |
| ACTIVITY     | ✅ Full | Heartbeat loop against a voice channel |
| ACHIEVEMENT  | ✅ Full | Heartbeat fallback + discordsays OAuth2 bypass |
| GAME         | ⚠️ Limited | Tries the discordsays bypass; can't fake a running process server-side |
| STREAM       | ⚠️ Limited | Same as GAME |

For GAME / STREAM quests, use the original userscript inside your Discord desktop client.

## Commands

All commands use the configurable prefix (`;` by default).

| Command | Where | Description |
|---------|-------|-------------|
| `;link` | Server or DM | Start the token-linking flow. If run in a server, the bot DMs you to ask for the token privately. |
| `;unlink` | Anywhere | Remove your linked token from storage. |
| `;quests` | Anywhere | List all currently active (uncompleted) quests on your account. |
| `;quest <name>` | Anywhere | Complete a specific quest. `<name>` is fuzzy-matched (e.g. `;quest watch video`). You can also pass a quest ID. |
| `;questall` | Anywhere | Complete every active quest sequentially. Auto-claims rewards. |
| `;claim <questId>` | Anywhere | Manually claim the reward for a completed quest. |
| `;status` | Anywhere | Show your linked-account info. Alias: `;me`. |
| `;help` | Anywhere | Show the command reference. |

## Setup

### 1. Create the bot application

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Open the **Bot** tab, click **Reset Token**, and copy the token.
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
   - **Server Members Intent** (optional, recommended)
4. Under **OAuth2 → URL Generator**, select `bot` + `applications.commands`, with permission **Send Messages** + **Read Message History**. Open the URL to invite the bot to your server.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | yes | The bot token from step 1. |
| `ALLOWED_USER_IDS` | recommended | Comma-separated Discord user IDs allowed to use the bot. Leave empty to allow anyone who DMs the bot. |
| `COMMAND_PREFIX` | no | Default `;`. |
| `TOKEN_ENCRYPTION_KEY` | recommended | 64-hex-char AES-256 key. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. If unset, tokens are stored in plaintext. |
| `DATABASE_PATH` | no | Default `./data/tokens.db`. |
| `DISCORD_API_BASE` | no | Default `https://discord.com/api/v9`. |
| `DEBUG` | no | `true` / `false`. Default `false`. |

### 3. Run locally

```bash
npm install
npm start
```

### 4. Get your Discord user token

Discord doesn't make this easy by design. The flow:

1. Open Discord in your **browser** (the desktop app hides the network tab).
2. Press `F12` to open DevTools.
3. Go to the **Network** tab and reload the page.
4. Click any request to `discord.com`.
5. In **Request Headers**, find `Authorization: <token>`. Copy the token value.

Then DM the bot `;link` and paste the token in DMs.

## Deploy to Railway

This repo includes a `nixpacks.toml` configured for Railway.

1. Push this repo to GitHub (make sure `.env` is **not** committed — it's in `.gitignore`).
2. Go to <https://railway.com> → **New Project** → **Deploy from GitHub repo**.
3. Select your repo.
4. Under **Variables**, add the same keys as in `.env` (Railway injects them as real env vars).
5. Railway auto-detects Node.js via `nixpacks.toml` and runs `node src/index.js`.
6. The bot will start within ~1 minute.

### Note on the database

Railway containers are ephemeral — the SQLite DB in `./data/tokens.db` will reset on redeploy. For a persistent bot, either:

- Use a Railway **Volume** mounted at `/app/data`, OR
- Swap `tokenStore.js` for a hosted DB (Postgres, Turso, etc.).

## Project structure

```
zuest/
├── package.json           # Dependencies + scripts
├── nixpacks.toml          # Railway deployment config
├── .env.example           # Environment template (committed)
├── .env                   # Your real values (gitignored)
├── .gitignore
├── README.md
└── src/
    ├── index.js           # Bot entry point — wires up Discord.js + dispatch
    ├── core/
    │   ├── logger.js          # ANSI-colored leveled logger
    │   ├── tokenStore.js      # SQLite + AES-256-GCM encrypted token storage
    │   ├── discordApi.js      # HTTP client for Discord API (with user token)
    │   ├── questWatcher.js    # Gateway WebSocket client — fetches quest list
    │   ├── questCompleter.js  # Ported quest-completion logic
    │   └── linkSession.js     # DM-based token-linking flow
    ├── commands/
    │   └── index.js           # All ;command handlers
    └── utils/
        ├── embeds.js          # Embed builders
        └── fuzzy.js           # Fuzzy quest-name matching
```

## Security notes

- Tokens are stored **AES-256-GCM encrypted at rest** if `TOKEN_ENCRYPTION_KEY` is set.
- If a user accidentally pastes a token in a public channel, the bot **auto-deletes** the message and DMs them a warning.
- The `;link` command always collects the token via **DM**, even if invoked in a server.
- Set `ALLOWED_USER_IDS` to lock the bot to specific users.

## License

MIT — see `package.json`. Use responsibly.

## Credits

- Quest-completion logic ported from [nyxxbit/discord-quest-completer](https://github.com/nyxxbit/discord-quest-completer).
- Bot framework: [discord.js](https://discord.js.org).
