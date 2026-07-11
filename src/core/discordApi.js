/* ─────────────────────────────────────────────────────────────
   discordApi.js — HTTP client for Discord's API using a USER token.

   This is the core piece that lets Zuest call the Quests endpoints
   on behalf of a linked user. Bots do NOT have access to the Quests
   API — only real user accounts do. So we make raw fetch() calls
   with the user's stored token.

   All endpoint paths mirror the reference userscript (orion/discord-quest-completer):
     POST /quests/{questId}/enroll
     POST /quests/{questId}/video-progress
     POST /quests/{questId}/heartbeat
     POST /quests/{questId}/claim-reward
     GET  /applications/public?application_ids=...
     POST /oauth2/authorize
     POST /applications/{appId}/proxy-tickets
     GET  /oauth2/tokens
     DELETE /oauth2/tokens/{id}
   ───────────────────────────────────────────────────────────── */
"use strict";

const log = require("./logger");
const { QuestWatcher } = require("./questWatcher");

const API_BASE = process.env.DISCORD_API_BASE || "https://discord.com/api/v9";

// Singleton — fallback gateway client used when REST endpoints don't return quest data.
const questWatcher = new QuestWatcher();

// In-memory cache of quest responses, keyed by token suffix.
const questCache = new Map();
const questInflight = new Map();

// Mimic a real Discord desktop client. Discord will 401/403 some endpoints
// if the User-Agent / super-properties look too bot-like.
const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Discord/1.0.9059 Chrome/126.0.6478.186 Electron/31.0.0 Safari/537.36",
  "X-Super-Properties": Buffer.from(JSON.stringify({
    os: "Windows",
    browser: "Discord Client",
    release_channel: "stable",
    client_version: "1.0.9059",
    os_version: "10.0.22621",
    os_arch: "x64",
    system_locale: "en-US",
    client_build_number: 290593,
    native_build_number: 47183,
    client_event_source: null
  })).toString("base64"),
  "X-Discord-Locale": "en-US",
  "X-Discord-Timezone": "America/Los_Angeles"
};

class DiscordApiError extends Error {
  constructor(status, body, url) {
    const msg = body?.message || `HTTP ${status}`;
    super(msg);
    this.status = status;
    this.body = body || {};
    this.url = url;
    this.isRetryable = status === 429 || (status >= 500 && status < 600);
    this.isClientError = status === 400 || status === 401 || status === 403 || status === 404 || status === 410;
  }
}

/**
 * Make an authenticated request to Discord's API.
 *
 * @param {object} opts
 * @param {string} opts.token         User token (NOT bot token)
 * @param {string} opts.method        GET | POST | DELETE | PUT | PATCH
 * @param {string} opts.path          Path beginning with "/" (relative to API_BASE)
 * @param {object} [opts.query]       Query string params
 * @param {object} [opts.body]        JSON body
 * @param {number} [opts.maxRetries]  Default 3
 */
async function request(opts) {
  const { token, method = "GET", path, query, body, maxRetries = 3 } = opts;
  if (!token) throw new Error("No token provided to Discord API client");

  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    ...DEFAULT_HEADERS,
    "Authorization": token
  };
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  if (bodyStr !== undefined) headers["Content-Length"] = Buffer.byteLength(bodyStr);

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    let res;
    try {
      res = await fetch(url, { method, headers, body: bodyStr });
    } catch (e) {
      if (attempt > maxRetries) throw new DiscordApiError(0, { message: e.message }, url.toString());
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    let parsedBody = null;
    const text = await res.text();
    if (text) {
      try { parsedBody = JSON.parse(text); }
      catch (_) { parsedBody = text; }
    }

    if (res.ok) return { status: res.status, body: parsedBody };

    // Retry on 429 / 5xx
    if ((res.status === 429 || res.status >= 500) && attempt <= maxRetries) {
      const retryAfter = parsedBody?.retry_after ?? Math.pow(2, attempt);
      const isGlobal = parsedBody?.global === true;
      log.warn(`[Network] Retry ${attempt}/${maxRetries} in ${retryAfter.toFixed(1)}s (HTTP ${res.status}${isGlobal ? " GLOBAL" : ""}) — ${path}`);
      await sleep(retryAfter * 1000 + Math.floor(Math.random() * 400));
      continue;
    }

    throw new DiscordApiError(res.status, parsedBody, url.toString());
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────
   High-level helpers
   ───────────────────────────────────────────────────────────── */

/** Returns /users/@me — used to validate the token + fetch account info. */
async function getMe(token) {
  const { body } = await request({ token, method: "GET", path: "/users/@me" });
  return body;
}

/**
 * Try a single REST endpoint for quest data.
 * Returns the parsed body, or null if 404/403/401.
 * Throws on other errors.
 */
async function tryQuestEndpoint(token, basePath, apiVersion = "v9") {
  const url = `https://discord.com/api/${apiVersion}${basePath}`;
  const headers = {
    ...DEFAULT_HEADERS,
    "Authorization": token
  };
  try {
    const res = await fetch(url, { method: "GET", headers });
    if (res.status === 404 || res.status === 403 || res.status === 401) {
      log.debug(`[QuestProbe] ${apiVersion}${basePath} → ${res.status}`);
      return null;
    }
    const text = await res.text();
    let body = text;
    if (text) { try { body = JSON.parse(text); } catch (_) { /* keep text */ } }
    log.debug(`[QuestProbe] ${apiVersion}${basePath} → ${res.status} (${Array.isArray(body) ? body.length + " items" : typeof body})`);
    if (!res.ok) return null;
    return body;
  } catch (e) {
    log.debug(`[QuestProbe] ${apiVersion}${basePath} → network error: ${e.message}`);
    return null;
  }
}

/**
 * Normalize various quest response shapes into a flat array.
 */
function normalizeQuestResponse(body) {
  if (body == null) return [];
  if (Array.isArray(body)) return body;
  if (typeof body === "object") {
    if (Array.isArray(body.quests)) return body.quests;
    if (Array.isArray(body.user_quests)) return body.user_quests;
    if (Array.isArray(body.assignments)) return body.assignments;
    if (Array.isArray(body.user_state)) return body.user_state;
    // Object map of questId → quest
    const vals = Object.values(body);
    if (vals.length > 0 && vals[0] && (vals[0].id || vals[0].quest_id || vals[0].config)) {
      return vals;
    }
  }
  return [];
}

/**
 * Get all active quests for the linked account.
 *
 * STRATEGY (in order):
 *   1. `/quests/@me` — the canonical quest endpoint. Returns:
 *        { quests: [...], excluded_quests: [...], quest_enrollment_blocked_until: null }
 *      An empty `quests` array means Discord has not assigned any quests
 *      to this account (common for fresh/alt accounts — see README).
 *   2. Gateway fallback — only if /quests/@me itself errors out.
 *
 * Results are cached for 60 seconds.
 *
 * @param {string} token
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]   Bypass the cache.
 * @param {boolean} [opts.returnMeta=false]     Return { quests, raw } instead of just quests.
 * @returns {Promise<Array|{quests: Array, raw: object}>}
 */
async function getQuests(token, opts = {}) {
  const key = token.slice(-12);
  if (!opts.forceRefresh) {
    const cached = questCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < 60 * 1000) {
      log.debug(`[Quests] Cache hit (token ...${key}, ${cached.quests.length} quests)`);
      return opts.returnMeta ? { quests: cached.quests, raw: cached.raw } : cached.quests;
    }
  }

  // Dedupe concurrent fetches
  if (questInflight.has(key)) return questInflight.get(key);

  const p = (async () => {
    // ── Primary: /quests/@me ───────────────────────────────────
    log.info(`[Quests] Fetching via /quests/@me ...`);
    try {
      const body = await tryQuestEndpoint(token, "/quests/@me", "v9");
      if (body !== null) {
        const quests = normalizeQuestResponse(body.quests ?? body);
        log.info(`[Quests] /quests/@me returned ${quests.length} quest(s). excluded_quests: ${(body.excluded_quests || []).length}, blocked_until: ${body.quest_enrollment_blocked_until || "null"}`);
        questCache.set(key, { quests, fetchedAt: Date.now(), raw: body });
        return opts.returnMeta ? { quests, raw: body } : quests;
      }
    } catch (e) {
      log.warn(`[Quests] /quests/@me failed: ${e.message}`);
    }

    // ── Fallback: gateway WebSocket ────────────────────────────
    log.warn(`[Quests] /quests/@me unavailable — falling back to gateway.`);
    try {
      const gatewayQuests = await questWatcher.fetchQuests(token, opts);
      questCache.set(key, { quests: gatewayQuests, fetchedAt: Date.now(), raw: { source: "gateway" } });
      return opts.returnMeta ? { quests: gatewayQuests, raw: { source: "gateway" } } : gatewayQuests;
    } catch (e) {
      log.error(`[Quests] Gateway fallback also failed: ${e.message}`);
      throw e;
    }
  })().finally(() => questInflight.delete(key));

  questInflight.set(key, p);
  return p;
}

/**
 * Diagnostic: probe all known quest endpoints and return a report.
 * Used by the `;debug quests` command.
 */
async function probeQuestEndpoints(token) {
  const report = [];
  const endpoints = [
    "/users/@me/quests",
    "/quests/@me",
    "/quests",
    "/users/@me/quests/streaks",
    "/users/@me/activities",
    "/applications/@me/quests",
    "/users/@me",
    "/users/@me/guilds"
  ];
  const versions = ["v9", "v10"];

  for (const ver of versions) {
    for (const path of endpoints) {
      const url = `https://discord.com/api/${ver}${path}`;
      const headers = { ...DEFAULT_HEADERS, Authorization: token };
      try {
        const res = await fetch(url, { method: "GET", headers });
        const text = await res.text();
        let preview = text.slice(0, 200);
        if (text) { try { preview = JSON.stringify(JSON.parse(text)).slice(0, 200); } catch (_) {} }
        report.push({
          endpoint: `/api/${ver}${path}`,
          status: res.status,
          ok: res.ok,
          preview
        });
      } catch (e) {
        report.push({
          endpoint: `/api/${ver}${path}`,
          status: 0,
          ok: false,
          preview: `network error: ${e.message}`
        });
      }
    }
  }
  return report;
}

async function enrollQuest(token, questId) {
  return request({
    token, method: "POST", path: `/quests/${questId}/enroll`,
    body: { location: 11, is_targeted: false }
  });
}

async function sendVideoProgress(token, questId, timestamp) {
  return request({
    token, method: "POST", path: `/quests/${questId}/video-progress`,
    body: { timestamp: Number(timestamp.toFixed(6)) }
  });
}

async function sendHeartbeat(token, questId, streamKey, terminal = false) {
  return request({
    token, method: "POST", path: `/quests/${questId}/heartbeat`,
    body: { stream_key: streamKey, terminal }
  });
}

async function claimReward(token, questId) {
  return request({
    token, method: "POST", path: `/quests/${questId}/claim-reward`,
    body: {
      platform: 0, location: 11, is_targeted: false,
      metadata_raw: null, metadata_sealed: null,
      traffic_metadata_raw: null, traffic_metadata_sealed: null
    }
  });
}

async function getApplicationPublic(token, appId) {
  const { body } = await request({
    token, method: "GET", path: "/applications/public",
    query: { application_ids: appId }
  });
  return Array.isArray(body) ? body[0] : body;
}

async function getOauth2Tokens(token) {
  const { body } = await request({ token, method: "GET", path: "/oauth2/tokens" });
  return Array.isArray(body) ? body : [];
}

async function deleteOauth2Token(token, grantId) {
  return request({ token, method: "DELETE", path: `/oauth2/tokens/${grantId}` });
}

async function authorizeOauth2(token, appId) {
  return request({
    token, method: "POST", path: "/oauth2/authorize",
    query: {
      response_type: "code",
      client_id: appId,
      scope: "identify applications.commands applications.entitlements"
    },
    body: {
      permissions: "0",
      authorize: true,
      integration_type: 1,
      location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
    }
  });
}

async function getProxyTicket(token, appId) {
  return request({
    token, method: "POST", path: `/applications/${appId}/proxy-tickets`,
    body: {}
  });
}

/**
 * Direct (CSP-free, server-side) call to discordsays.com — used for the
 * ACHIEVEMENT quest bypass. In a bot context there's no browser CSP, so
 * we can call this directly with fetch().
 */
async function discordsaysPost(appId, pathSuffix, headers, jsonBody) {
  if (!/^\d+$/.test(String(appId))) throw new Error("Non-numeric appId refused");
  const url = `https://${appId}.discordsays.com/${pathSuffix.replace(/^\//, "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody),
    redirect: "error"
  });
  const text = await res.text();
  let body = text;
  if (text) { try { body = JSON.parse(text); } catch (_) { /* keep text */ } }
  if (!res.ok) throw new DiscordApiError(res.status, body, url);
  return { status: res.status, body };
}

module.exports = {
  DiscordApiError,
  request,
  // High-level
  getMe,
  getQuests,
  probeQuestEndpoints,
  enrollQuest,
  sendVideoProgress,
  sendHeartbeat,
  claimReward,
  getApplicationPublic,
  getOauth2Tokens,
  deleteOauth2Token,
  authorizeOauth2,
  getProxyTicket,
  discordsaysPost
};
