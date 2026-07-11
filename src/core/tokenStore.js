/* ─────────────────────────────────────────────────────────────
   tokenStore.js — SQLite-backed encrypted token storage

   Each row in `linked_accounts`:
     user_id        TEXT PRIMARY KEY  (Discord user ID of the bot user)
     username       TEXT              (cached "#name" or new username)
     discriminator  TEXT
     token_cipher   BLOB              (AES-256-GCM ciphertext)
     token_iv       BLOB
     token_tag      BLOB
     created_at     INTEGER           (ms epoch)
     last_used_at   INTEGER
   ───────────────────────────────────────────────────────────── */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const log = require("./logger");

const ALGO = "aes-256-gcm";

function deriveKey(raw) {
  // If a hex 64-char string is provided, use it directly as the 32-byte key.
  // Otherwise, derive a 32-byte key via SHA-256 of the passphrase.
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(String(raw)).digest();
}

class TokenStore {
  constructor(dbPath, encryptionKeyRaw) {
    // Ensure parent dir exists
    const abs = path.resolve(dbPath || "./data/tokens.db");
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    this.db = new Database(abs);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS linked_accounts (
        user_id        TEXT PRIMARY KEY,
        username       TEXT,
        discriminator  TEXT,
        global_name    TEXT,
        token_cipher   BLOB NOT NULL,
        token_iv       BLOB NOT NULL,
        token_tag      BLOB NOT NULL,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER
      );
    `);

    this.key = deriveKey(encryptionKeyRaw);
    if (!this.key) {
      log.warn("TOKEN_ENCRYPTION_KEY not set — tokens will be stored in PLAINTEXT. Set TOKEN_ENCRYPTION_KEY in production!");
    }
  }

  _encrypt(plain) {
    if (!this.key) {
      // Plaintext fallback: store raw UTF-8 with empty iv/tag markers
      return { cipher: Buffer.from(plain, "utf8"), iv: Buffer.alloc(0), tag: Buffer.alloc(0) };
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { cipher: enc, iv, tag };
  }

  _decrypt(row) {
    if (!this.key) return row.token_cipher.toString("utf8");
    const decipher = crypto.createDecipheriv(ALGO, this.key, row.token_iv);
    decipher.setAuthTag(row.token_tag);
    return Buffer.concat([decipher.update(row.token_cipher), decipher.final()]).toString("utf8");
  }

  /** Link (or replace) a token for a Discord user. */
  link(userId, accountInfo, token) {
    const { cipher, iv, tag } = this._encrypt(token);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO linked_accounts
        (user_id, username, discriminator, global_name, token_cipher, token_iv, token_tag, created_at, last_used_at)
      VALUES (@user_id, @username, @discriminator, @global_name, @cipher, @iv, @tag, @now, @now)
      ON CONFLICT(user_id) DO UPDATE SET
        username      = excluded.username,
        discriminator = excluded.discriminator,
        global_name   = excluded.global_name,
        token_cipher  = excluded.token_cipher,
        token_iv      = excluded.token_iv,
        token_tag     = excluded.token_tag,
        created_at    = excluded.created_at,
        last_used_at  = excluded.last_used_at
    `).run({
      user_id: userId,
      username: accountInfo.username || null,
      discriminator: accountInfo.discriminator || "0",
      global_name: accountInfo.global_name || null,
      cipher, iv, tag, now
    });
    log.info(`Linked account for user ${userId} (${accountInfo.username || "unknown"})`);
  }

  /** Remove the linked token for a user. Returns true if a row was deleted. */
  unlink(userId) {
    const r = this.db.prepare(`DELETE FROM linked_accounts WHERE user_id = ?`).run(userId);
    return r.changes > 0;
  }

  /** Returns the decrypted token (or null). Also bumps last_used_at. */
  getToken(userId) {
    const row = this.db.prepare(`SELECT * FROM linked_accounts WHERE user_id = ?`).get(userId);
    if (!row) return null;
    try {
      const token = this._decrypt(row);
      this.db.prepare(`UPDATE linked_accounts SET last_used_at = ? WHERE user_id = ?`)
        .run(Date.now(), userId);
      return token;
    } catch (e) {
      log.error(`Failed to decrypt token for ${userId}: ${e.message}`);
      return null;
    }
  }

  /** Returns public (non-token) info about a linked account. */
  getInfo(userId) {
    const row = this.db.prepare(`
      SELECT user_id, username, discriminator, global_name, created_at, last_used_at
      FROM linked_accounts WHERE user_id = ?
    `).get(userId);
    return row || null;
  }

  isLinked(userId) {
    return !!this.db.prepare(`SELECT 1 FROM linked_accounts WHERE user_id = ?`).get(userId);
  }

  count() {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM linked_accounts`).get().n;
  }
}

module.exports = { TokenStore };
