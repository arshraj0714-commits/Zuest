/* ─────────────────────────────────────────────────────────────
   questWatcher.js — fetches quest data via Discord's GATEWAY.

   WHY: Discord does NOT expose a REST endpoint to LIST quests.
        The 404 from `/users/@me/quests` and `/quests` is expected —
        those endpoints don't exist. Quest data is pushed to clients
        over the WebSocket gateway as part of the READY event or via
        `USER_QUESTS_UPDATED` dispatch events.

   The reference userscript reads from `Mods.QuestStore.quests`,
   which is a Flux store populated by gateway events. Since we run
   server-side, we need to open our own gateway connection with
   the user's token, receive the quest data, and disconnect.

   FLOW:
     1. Connect to wss://gateway.discord.gg/?v=9&encoding=json
     2. Receive HELLO (op 10) → start heartbeating
     3. Send IDENTIFY (op 2) with user token + invisible presence
     4. Receive READY (op 0, t=READY) → may contain quests under
        user_state.quests, quests, or user_quests
     5. Wait briefly for USER_QUESTS_UPDATED dispatch
     6. Cache + return the quest array, close the socket

   CACHING: Results are cached for 60 seconds per token so repeated
            ;quests / ;questall / ;quest calls don't reconnect.
   ───────────────────────────────────────────────────────────── */
"use strict";

const WebSocket = require("ws");
const log = require("./logger");

const GATEWAY_URL = "wss://gateway.discord.gg/?v=9&encoding=json";
const CACHE_TTL_MS = 60 * 1000;        // cache quest lists for 1 minute
const FETCH_TIMEOUT_MS = 30 * 1000;    // hard abort if we take too long (increased from 20s)
const POST_READY_WAIT_MS = 10000;      // wait this long after READY for follow-up events (was 5s)

class QuestWatcher {
  constructor() {
    /** @type {Map<string, {quests: Array, fetchedAt: number}>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<Array>>} — dedupes concurrent fetches */
    this.inflight = new Map();
  }

  _cacheKey(token) {
    // Use the last 12 chars of the token as a non-reversible cache key
    return token.slice(-12);
  }

  /**
   * Fetch the linked user's active quests.
   * @param {string} token
   * @param {object} [opts]
   * @param {boolean} [opts.forceRefresh=false]
   * @returns {Promise<Array>} Quest objects (may be empty).
   */
  async fetchQuests(token, opts = {}) {
    const key = this._cacheKey(token);

    // Cache hit?
    if (!opts.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        log.debug(`[QuestWatcher] Cache hit (token ...${key}, ${cached.quests.length} quests)`);
        return cached.quests;
      }
    }

    // Dedupe concurrent fetches for the same token
    if (this.inflight.has(key)) {
      log.debug(`[QuestWatcher] Awaiting in-flight fetch for token ...${key}`);
      return this.inflight.get(key);
    }

    const p = this._fetchViaGateway(token).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  _fetchViaGateway(token) {
    return new Promise((resolve, reject) => {
      log.info(`[QuestWatcher] Opening gateway connection to fetch quests...`);
      const ws = new WebSocket(GATEWAY_URL);
      let heartbeatTimer = null;
      let resolved = false;
      let quests = [];
      let readyAt = null;
      let postReadyTimer = null;

      const cleanup = () => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (postReadyTimer) { clearTimeout(postReadyTimer); postReadyTimer = null; }
        try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(); } catch (_) {}
      };

      const finish = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        clearTimeout(overallTimeout);
        if (err) {
          log.error(`[QuestWatcher] Failed: ${err.message}`);
          reject(err);
        } else {
          const key = this._cacheKey(token);
          this.cache.set(key, { quests, fetchedAt: Date.now() });
          log.success(`[QuestWatcher] Got ${quests.length} quest(s), cached for ${CACHE_TTL_MS / 1000}s`);
          resolve(quests);
        }
      };

      const overallTimeout = setTimeout(() => {
        log.warn(`[QuestWatcher] Timeout reached — returning ${quests.length} quest(s)`);
        finish();
      }, FETCH_TIMEOUT_MS);

      ws.on("message", (raw) => {
        let payload;
        try { payload = JSON.parse(raw); } catch (_) { return; }
        const { op, t, d } = payload;

        // When DEBUG=true, log EVERY event name we receive — this is
        // invaluable for diagnosing which event carries quest data.
        const isDebug = (process.env.DEBUG || "").toLowerCase() === "true";
        if (isDebug) {
          const keys = d && typeof d === "object" ? Object.keys(d).slice(0, 15).join(",") : "";
          log.debug(`[QuestWatcher] ← op=${op} t=${t || "-"} d.keys=[${keys}]`);
        }

        // HELLO — start heartbeating + send IDENTIFY
        if (op === 10) {
          log.debug(`[QuestWatcher] HELLO received (heartbeat: ${d.heartbeat_interval}ms)`);
          heartbeatTimer = setInterval(() => {
            try { ws.send(JSON.stringify({ op: 1, d: null })); } catch (_) {}
          }, d.heartbeat_interval);

          ws.send(JSON.stringify({
            op: 2,
            d: {
              token,
              properties: {
                os: "Windows",
                browser: "Discord Client",
                release_channel: "stable",
                client_version: "1.0.9059",
                os_version: "10.0.22621",
                os_arch: "x64",
                system_locale: "en-US"
              },
              compress: false,
              presence: { status: "invisible", since: 0, activities: [], afk: false }
            }
          }));
        }

        // INVALID_SESSION — token rejected or session race
        if (op === 9) {
          finish(new Error(d ? "Invalid session (resumable)" : "Invalid session — token rejected by Discord"));
          return;
        }

        // READY — may contain quests inline
        if (op === 0 && t === "READY") {
          readyAt = Date.now();
          log.debug(`[QuestWatcher] READY received. Top-level keys: ${Object.keys(d || {}).join(", ")}`);

          // Try a wide set of possible locations for quest data in READY
          const candidates = [
            d?.user_state?.quests,
            d?.quests,
            d?.user_quests,
            d?.user?.quests,
            d?.session?.quests,
            d?.user_state?.user_quests
          ];
          for (const c of candidates) {
            if (Array.isArray(c) && c.length > 0) { quests = c; break; }
            if (c && typeof c === "object" && !Array.isArray(c)) {
              const vals = Object.values(c);
              if (vals.length > 0 && vals[0] && (vals[0].id || vals[0].quest_id)) {
                quests = vals;
                break;
              }
            }
          }
          log.debug(`[QuestWatcher] Extracted ${quests.length} quest(s) from READY`);

          // Give Discord a few seconds to push a follow-up USER_QUESTS_UPDATED
          postReadyTimer = setTimeout(() => {
            log.debug(`[QuestWatcher] Post-READY wait complete — final quest count: ${quests.length}`);
            finish();
          }, POST_READY_WAIT_MS);
        }

        // Quest-specific dispatch events
        if (op === 0 && (
          t === "USER_QUESTS_UPDATED" ||
          t === "USER_QUESTS" ||
          t === "QUESTS_UPDATED" ||
          t === "QUESTS_ENROLLMENT_UPDATE" ||
          t === "USER_QUEST_ENROLLMENT"
        )) {
          log.debug(`[QuestWatcher] Received dispatch: ${t}`);

          // Try various shapes
          const candidates = [d, d?.quests, d?.user_quests, d?.user_state?.quests];
          for (const c of candidates) {
            if (Array.isArray(c) && c.length > 0) { quests = c; break; }
            if (c && typeof c === "object" && !Array.isArray(c)) {
              const vals = Object.values(c);
              if (vals.length > 0 && (vals[0]?.id || vals[0]?.quest_id)) {
                quests = vals;
                break;
              }
            }
          }
          // Got fresh data — finish immediately
          clearTimeout(postReadyTimer);
          finish();
        }

        // Auth failure
        if (op === 0 && t === "AUTH_SESSION_UPDATE" && d?.verified === false) {
          finish(new Error("Discord rejected the token (AUTH_SESSION_UPDATE verified=false)"));
        }
      });

      ws.on("error", (err) => {
        log.error(`[QuestWatcher] WebSocket error: ${err.message}`);
        finish(err);
      });

      ws.on("close", (code, reason) => {
        const r = reason?.toString?.() || "";
        log.debug(`[QuestWatcher] Connection closed (code ${code}${r ? `: ${r}` : ""})`);
        if (!resolved) {
          if (readyAt) {
            // Closed after READY — return what we have
            finish();
          } else {
            // Closed before READY — likely auth failure
            const msg = code === 4004 ? "Authentication failed — token is invalid"
                      : code === 4014 ? "Disallowed intent(s)"
                      : `Gateway closed before READY (code ${code})`;
            finish(new Error(msg));
          }
        }
      });
    });
  }

  /** Invalidate the cache for a specific token (e.g. after unlinking). */
  invalidate(token) {
    this.cache.delete(this._cacheKey(token));
  }
}

module.exports = { QuestWatcher };
