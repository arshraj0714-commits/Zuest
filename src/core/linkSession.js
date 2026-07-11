/* ─────────────────────────────────────────────────────────────
   linkSession.js — manages the in-progress DM token-linking flow.

   When a user runs ;link, we start a "link session" keyed by their
   Discord user ID. Their next DM (within the timeout window) is
   interpreted as their token. We validate it by calling /users/@me,
   then store it via the TokenStore.
   ───────────────────────────────────────────────────────────── */
"use strict";

const log = require("./logger");
const api = require("./discordApi");
const embeds = require("../utils/embeds");

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

class LinkSession {
  constructor(tokenStore) {
    this.tokenStore = tokenStore;
    /** @type {Map<string, { startedAt: number }>} */
    this.sessions = new Map();
    // Periodic cleanup
    setInterval(() => this._gc(), 60 * 1000).unref();
  }

  _gc() {
    const now = Date.now();
    for (const [userId, sess] of this.sessions) {
      if (now - sess.startedAt > SESSION_TTL_MS) {
        this.sessions.delete(userId);
      }
    }
  }

  start(userId) {
    this.sessions.set(userId, { startedAt: Date.now() });
  }

  isActive(userId) {
    const s = this.sessions.get(userId);
    if (!s) return false;
    if (Date.now() - s.startedAt > SESSION_TTL_MS) {
      this.sessions.delete(userId);
      return false;
    }
    return true;
  }

  end(userId) {
    this.sessions.delete(userId);
  }

  /**
   * Handle a DM that may be a token submission.
   * Returns true if the message was consumed by a link session.
   */
  async handleTokenSubmission(message) {
    const userId = message.author.id;
    if (!this.isActive(userId)) return false;

    const content = message.content.trim();

    // Allow user to cancel
    if (content.toLowerCase() === "cancel") {
      this.end(userId);
      await message.reply({ embeds: [embeds.warn("Link cancelled", "No token was stored.")] });
      try { await message.delete().catch(() => {}); } catch (_) {}
      return true;
    }

    // Validate token shape (very loose — Discord tokens are 3 dot-separated base64-ish segments)
    if (!/^[\w\-]+\.[\w\-]+\.[\w\-]+$/.test(content)) {
      await message.reply({
        embeds: [embeds.error(
          "That doesn't look like a token",
          "A Discord user token is three segments separated by dots.\n\nTry again, or type `cancel` to abort."
        )]
      });
      return true;
    }

    // Try to delete the user's token message immediately for privacy
    try { await message.delete(); } catch (_) { /* DMs may not allow */ }

    const thinking = await message.reply({ embeds: [embeds.info("Verifying...", "Checking your token against Discord's API.")] });

    try {
      const me = await api.getMe(content);
      if (!me || !me.id) {
        throw new Error("Invalid response from /users/@me");
      }
      // Store the token!
      this.tokenStore.link(userId, {
        username: me.username,
        discriminator: me.discriminator,
        global_name: me.global_name
      }, content);

      await thinking.edit({
        embeds: [embeds.success(
          "Account linked ✅",
          `Welcome, **${me.global_name || me.username}**!\n\n` +
          `Your token is now ${this.tokenStore.key ? "AES-256 encrypted and" : ""} stored.\n` +
          `Run \`/quests\` (or whatever prefix you set) to see your available quests.`
        )]
      });
      this.end(userId);
      return true;
    } catch (e) {
      log.error(`Token validation failed for user ${userId}: ${e.message}`);
      await thinking.edit({
        embeds: [embeds.error(
          "Token rejected",
          `Discord rejected this token: \`${e.body?.message || e.message}\` (HTTP ${e.status ?? "?"}).\n\n` +
          `Try again with a fresh token, or type \`cancel\` to abort.`
        )]
      });
      // Keep the session active so they can retry
      return true;
    }
  }
}

module.exports = { LinkSession };
