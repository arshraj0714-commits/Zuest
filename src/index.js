/* ─────────────────────────────────────────────────────────────
   index.js — Zuest bot entry point

   Responsibilities:
     • Load config from env (BOT_TOKEN, ALLOWED_USER_IDS, etc.)
     • Initialize the SQLite-backed TokenStore
     • Wire up the LinkSession manager (DM-based token linking)
     • Connect to the Discord gateway as the bot
     • Dispatch ;commands
     • Auto-delete token-shaped messages posted in servers (safety)
   ───────────────────────────────────────────────────────────── */
"use strict";

require("dotenv").config();

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const log = require("./core/logger");
const { TokenStore } = require("./core/tokenStore");
const { LinkSession } = require("./core/linkSession");
const commands = require("./commands");
const embeds = require("./utils/embeds");

// ─── config ───────────────────────────────────────────────────

const BOT_TOKEN        = process.env.BOT_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const PREFIX           = process.env.COMMAND_PREFIX || ";";
const DB_PATH          = process.env.DATABASE_PATH  || "./data/tokens.db";
const ENC_KEY          = process.env.TOKEN_ENCRYPTION_KEY || "";

if (!BOT_TOKEN || BOT_TOKEN === "REPLACE_WITH_YOUR_BOT_TOKEN") {
  log.error("BOT_TOKEN is not set. Edit your .env file and add a real bot token.");
  process.exit(1);
}

// ─── init stores ──────────────────────────────────────────────

const tokenStore = new TokenStore(DB_PATH, ENC_KEY);
const linkSession = new LinkSession(tokenStore);

const ctx = {
  bot: null,
  tokenStore,
  linkSession,
  prefix: PREFIX,
  allowedUserIds: ALLOWED_USER_IDS,
  isDm: (msg) => !msg.guild
};

// ─── discord client ───────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [
    Partials.Channel,    // required for DM events
    Partials.Message
  ]
});
ctx.bot = client;

client.once(Events.ClientReady, (c) => {
  log.success(`Zuest is online — logged in as ${c.user.tag}`);
  log.info(`Prefix: ${PREFIX}`);
  log.info(`Allowed users: ${ALLOWED_USER_IDS.length === 0 ? "(everyone)" : ALLOWED_USER_IDS.join(", ")}`);
  log.info(`Linked accounts in DB: ${tokenStore.count()}`);
  log.info(`Token encryption: ${ENC_KEY ? "enabled (AES-256-GCM)" : "DISABLED (plaintext — set TOKEN_ENCRYPTION_KEY)"}`);
  try {
    c.user.setActivity(`${PREFIX}help`, { type: 3 }); // Listening
  } catch (_) {}
});

// ─── message handler ──────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author?.bot) return;

  // ─── 1. DM-based token-linking flow ───────────────────────
  // If the user has an active link session AND this is a DM, treat
  // their message as a potential token submission.
  if (!message.guild && linkSession.isActive(message.author.id)) {
    const handled = await linkSession.handleTokenSubmission(message);
    if (handled) return;
  }

  // ─── 2. Safety: auto-delete token-shaped messages in servers
  // If someone accidentally pastes their token in a public channel,
  // delete it immediately and warn them in DMs.
  if (message.guild && commands.TOKEN_RE.test(message.content)) {
    try { await message.delete(); } catch (_) {}
    const match = message.content.match(commands.TOKEN_RE);
    if (match) {
      const masked = match[0].slice(0, 8) + "…(redacted)";
      log.warn(`Auto-deleted token-shaped message from ${message.author.tag} in #${message.channel.name} (${message.guild.name}): ${masked}`);
    }
    try {
      await message.author.send({
        embeds: [embeds.warn(
          "Token deleted 🛡️",
          `I deleted a message from you in **${message.guild.name}** because it looked like a Discord token.\n` +
          `Tokens grant full access to your account — never paste them in public channels.\n\n` +
          `If you meant to link your account, run \`${PREFIX}link\` first and reply in DMs.`
        )]
      });
    } catch (_) { /* DMs may be closed */ }
    return;
  }

  // ─── 3. Command dispatch ──────────────────────────────────
  if (!message.content.startsWith(PREFIX)) return;

  const body = message.content.slice(PREFIX.length).trim();
  if (!body) return;
  const parts = body.split(/\s+/);
  const name = parts.shift().toLowerCase();
  const args = parts;

  const handler = commands[name];
  if (!handler) return; // silently ignore unknown commands

  log.debug(`Command: ${PREFIX}${name} ${args.join(" ")} — by ${message.author.tag}${message.guild ? ` in ${message.guild.name}` : " (DM)"}`);

  try {
    await handler(message, args, ctx);
  } catch (e) {
    log.error(`Command ${name} threw: ${e.message}`);
    log.debug(e.stack);
    try {
      await message.reply({ embeds: [embeds.error("Something went wrong", `\`${e.message}\``)] });
    } catch (_) { /* ignore */ }
  }
});

// ─── error handling ───────────────────────────────────────────

client.on(Events.Error, (e) => log.error(`Discord client error: ${e.message}`));
client.on(Events.Warn,  (m) => log.warn(`Discord client warning: ${m}`));
process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled promise rejection: ${reason?.message || reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}`);
  log.debug(err.stack);
  // Don't crash — but log it loudly
});

// ─── graceful shutdown ────────────────────────────────────────

async function shutdown(signal) {
  log.info(`${signal} received — shutting down...`);
  try { await client.destroy(); } catch (_) {}
  try { tokenStore.db.close(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── connect ──────────────────────────────────────────────────

log.info("Connecting to Discord gateway...");
client.login(BOT_TOKEN).catch((e) => {
  log.error(`Failed to login: ${e.message}`);
  process.exit(1);
});
