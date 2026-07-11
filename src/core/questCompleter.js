/* ─────────────────────────────────────────────────────────────
   questCompleter.js — port of nyxxbit/discord-quest-completer

   The reference userscript runs INSIDE the Discord desktop client and
   patches its internal stores. We can't do that from a Node.js bot, so
   we adapt each task handler to operate purely via Discord's REST API
   using the linked user token.

   Supported task types:
     VIDEO        — fully supported (POST /quests/{id}/video-progress in a loop)
     ACTIVITY     — supported (heartbeat loop)
     ACHIEVEMENT  — supported via the discordsays OAuth2 bypass
     GAME         — limited (heartbeat attempt + bypass attempt; real
                    "fake process" injection is impossible server-side)
     STREAM       — limited (same as GAME)

   Each handler emits progress events to an optional onProgress callback
   so the bot can stream status updates back to the user via DMs.
   ───────────────────────────────────────────────────────────── */
"use strict";

const log = require("./logger");
const api = require("./discordApi");

const MAX_TIME_MS = 25 * 60 * 1000;       // hard abort per task
const MAX_FAILURES = 5;                    // consecutive network failures
const MAX_RETRIES = 3;

function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " ");
}

/**
 * Inspect a quest config and return our handler type for it.
 * Order matters: ACHIEVEMENT_IN_ACTIVITY must match before generic ACTIVITY.
 */
function detectType(cfg, applicationId) {
  const taskKeys = Object.keys(cfg?.tasks || {});
  const typeMap = [
    { key: "PLAY",                  type: "GAME" },
    { key: "STREAM",                type: "STREAM" },
    { key: "VIDEO",                 type: "WATCH_VIDEO" },
    { key: "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
    { key: "ACTIVITY",              type: "ACTIVITY" }
  ];
  for (const { key, type } of typeMap) {
    const keyName = taskKeys.find(k => k.includes(key));
    if (keyName) {
      return { type, keyName, target: cfg.tasks[keyName]?.target ?? 0 };
    }
  }
  if (applicationId) {
    return { type: "GAME", keyName: "PLAY_ON_DESKTOP", target: cfg.tasks[taskKeys[0]]?.target ?? 0 };
  }
  return null;
}

/** Normalize the various quest shapes Discord returns into one canonical form. */
function normalizeQuest(raw) {
  const cfg = raw.config?.taskConfig ?? raw.config?.taskConfigV2 ?? raw.config;
  const messages = raw.config?.messages ?? raw.messages ?? {};
  return {
    id: raw.id,
    name: messages.questName ?? raw.name ?? raw.config?.name ?? "Unknown Quest",
    expiresAt: raw.expires_at ?? raw.expiresAt ?? null,
    completedAt: raw.user_status?.completed_at ?? raw.userStatus?.completedAt ?? null,
    enrolledAt: raw.user_status?.enrolled_at ?? raw.userStatus?.enrolledAt ?? null,
    config: raw.config ?? {},
    userStatus: raw.user_status ?? raw.userStatus ?? {},
    applicationId: raw.config?.application?.id ?? null
  };
}

/** Returns true if the quest is not yet completed and not expired. */
function isQuestActive(q) {
  if (q.completedAt) return false;
  if (q.expiresAt && new Date(q.expiresAt).getTime() < Date.now()) return false;
  return true;
}

/* ─────────────────────────────────────────────────────────────
   Task handlers — each returns { ok, reason }
   ───────────────────────────────────────────────────────────── */

async function handleVideo(token, q, t, onProgress) {
  let cur = q.userStatus?.progress?.[t.keyName]?.value
          ?? q.userStatus?.progress?.WATCH_VIDEO?.value
          ?? 0;
  let failCount = 0;
  const startTime = Date.now();
  let calls = 0;

  // Simulate initial player buffer ping
  if (cur === 0) {
    await sleep(rnd(200, 350));
    cur = 0.2 + (Math.random() * 0.05);
    try {
      await api.sendVideoProgress(token, q.id, cur);
      calls++;
    } catch (_) { /* non-fatal */ }
  }

  while (cur < t.target) {
    const delayMs = rnd(3500, 4750);
    await sleep(delayMs);
    const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
    cur += elapsedSec;
    const payloadTs = Math.min(t.target, cur);

    try {
      const r = await api.sendVideoProgress(token, q.id, payloadTs);
      calls++;
      const serverVal = r.body?.progress?.[t.keyName]?.value ?? r.body?.progress?.WATCH_VIDEO?.value;
      if (serverVal > cur) cur = Math.min(t.target, serverVal);
      if (onProgress) onProgress({ questId: q.id, cur, max: t.target, type: "VIDEO" });
      if (r.body?.completed_at) { cur = t.target; break; }
      failCount = 0;
    } catch (e) {
      failCount++;
      if (e.isClientError) return { ok: false, reason: `Client error ${e.status}` };
      if (failCount >= MAX_FAILURES) return { ok: false, reason: "Too many network failures" };
      log.debug(`[Video] progress failed (${failCount}/${MAX_FAILURES}): ${e.message}`);
    }

    if (Date.now() - startTime > MAX_TIME_MS) return { ok: false, reason: "Timeout" };
  }

  return { ok: true, calls };
}

/**
 * Heartbeat loop — used for ACTIVITY quests. The reference script finds
 * a voice channel the user is in; we instead try to find ANY channel
 * from the linked account's guilds and use it as a fake stream key.
 */
async function handleActivity(token, q, t, onProgress) {
  // Try to find a usable voice channel ID for the stream key.
  // If we can't, use a synthetic ID — Discord may still accept heartbeats.
  let channelId = null;
  try {
    const guilds = await api.request({ token, method: "GET", path: "/users/@me/guilds" });
    for (const g of guilds.body || []) {
      try {
        const chans = await api.request({
          token, method: "GET",
          path: `/guilds/${g.id}/channels`
        });
        const voice = (chans.body || []).find(c => c.type === 2);
        if (voice) { channelId = voice.id; break; }
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* ignore */ }

  if (!channelId) channelId = String(rnd(100000000000000000, 999999999999999999));

  const streamKey = `call:${channelId}:${rnd(1000, 9999)}`;
  let cur = 0;
  let failCount = 0;
  const startTime = Date.now();

  while (cur < t.target) {
    try {
      const r = await api.sendHeartbeat(token, q.id, streamKey, false);
      cur = r.body?.progress?.[t.keyName]?.value
          ?? r.body?.progress?.PLAY_ACTIVITY?.value
          ?? cur + 20;
      if (onProgress) onProgress({ questId: q.id, cur, max: t.target, type: "ACTIVITY" });
      failCount = 0;
      if (cur >= t.target) {
        try { await api.sendHeartbeat(token, q.id, streamKey, true); } catch (_) { }
        break;
      }
    } catch (e) {
      failCount++;
      if (e.isClientError) return { ok: false, reason: `Client error ${e.status}` };
      if (failCount >= MAX_FAILURES) return { ok: false, reason: "Too many network failures" };
      log.debug(`[Activity] heartbeat failed (${failCount}/${MAX_FAILURES}): ${e.message}`);
    }

    if (Date.now() - startTime > MAX_TIME_MS) return { ok: false, reason: "Timeout" };
    await sleep(rnd(19000, 22000));
  }

  return { ok: true };
}

/**
 * ACHIEVEMENT bypass — server-side we CAN do the discordsays flow
 * (no CSP blocks us like in the browser userscript).
 *
 * Flow:
 *   1) /oauth2/authorize the quest's app (returns code in location URL)
 *   2) /applications/{appId}/proxy-tickets (returns proxy ticket)
 *   3) POST {appId}.discordsays.com/.proxy/acf/authorize {code} → DS token
 *   4) POST {appId}.discordsays.com/.proxy/acf/quest/progress {progress: target}
 *   5) /oauth2/tokens + DELETE to clean up the grant
 */
async function bypassAchievement(token, q, t) {
  const appId = q.config?.application?.id;
  if (!appId) return { ok: false, reason: "No application_id on quest" };

  // Snapshot existing grants so we revoke only the one we create.
  let preGrantIds;
  try {
    const before = await api.getOauth2Tokens(token);
    preGrantIds = new Set(
      before.filter(tk => tk.application?.id === String(appId)).map(tk => tk.id)
    );
  } catch (e) {
    return { ok: false, reason: `Couldn't snapshot existing grants: ${e.message}` };
  }

  try {
    log.info(`[Bypass] Trying Discord Says auth flow for "${t.name}"...`);

    const authRes = await api.authorizeOauth2(token, appId);
    const location = authRes.body?.location;
    if (!location) throw new Error("no location in /oauth2/authorize response");
    const authCode = new URL(location).searchParams.get("code");
    if (!authCode) throw new Error("no code in authorize location");

    const ticketRes = await api.getProxyTicket(token, appId);
    const proxyTicket = ticketRes.body?.ticket;
    if (!proxyTicket) throw new Error("no proxy ticket");

    const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

    // Step 3: get DS token
    const dsAuthRes = await api.discordsaysPost(
      appId,
      "/.proxy/acf/authorize",
      {
        "X-Auth-Token": "",
        "X-Discord-Quest-ID": q.id,
        "Referer": referrer
      },
      { code: authCode }
    );
    let dsToken;
    try { dsToken = typeof dsAuthRes.body === "string"
      ? JSON.parse(dsAuthRes.body)?.token
      : dsAuthRes.body?.token; }
    catch (_) { throw new Error("discordsays returned non-JSON"); }
    if (!dsToken) throw new Error("no discordsays token");

    // Step 4: push progress
    await api.discordsaysPost(
      appId,
      "/.proxy/acf/quest/progress",
      {
        "X-Auth-Token": dsToken,
        "X-Discord-Quest-ID": q.id,
        "Referer": referrer
      },
      { progress: t.target }
    );

    log.success(`[Bypass] "${t.name}" completed via Discord Says.`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError && /failed to fetch|networkerror/i.test(e.message)) {
      return { ok: false, reason: "Network blocked discordsays request" };
    }
    const code = e?.body?.code;
    if (code === 50165) {
      return { ok: false, reason: "Age-gated / delisted activity (50165)" };
    }
    const parts = [];
    if (e?.status) parts.push(`HTTP ${e.status}`);
    if (code) parts.push(`code ${code}`);
    if (e?.body?.message) parts.push(e.body.message);
    else if (e?.message) parts.push(e.message);
    return { ok: false, reason: parts.join(" — ") || "unknown" };
  } finally {
    // Revoke only the grant we created (diffed against snapshot)
    if (preGrantIds) {
      try {
        const after = await api.getOauth2Tokens(token);
        const ours = after.filter(tk =>
          tk.application?.id === String(appId) && !preGrantIds.has(tk.id)
        );
        for (const g of ours) {
          try { await api.deleteOauth2Token(token, g.id); }
          catch (_) { /* non-fatal */ }
        }
      } catch (e) {
        log.debug(`[Bypass] cleanup non-fatal: ${e.message}`);
      }
    }
  }
}

/**
 * ACHIEVEMENT handler — try heartbeat first (works for some quests),
 * then fall back to the discordsays bypass.
 */
async function handleAchievement(token, q, t, onProgress) {
  // Best-effort heartbeat attempt
  try {
    const channelId = String(rnd(100000000000000000, 999999999999999999));
    const streamKey = `call:${channelId}:${rnd(1000, 9999)}`;
    let cur = 0;
    let failCount = 0;
    const startTime = Date.now();

    while (cur < t.target) {
      try {
        const r = await api.sendHeartbeat(token, q.id, streamKey, false);
        cur = r.body?.progress?.[t.keyName]?.value
            ?? r.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value
            ?? cur;
        if (onProgress) onProgress({ questId: q.id, cur, max: t.target, type: "ACHIEVEMENT" });
        failCount = 0;
        if (cur >= t.target) {
          try { await api.sendHeartbeat(token, q.id, streamKey, true); } catch (_) { }
          return { ok: true };
        }
      } catch (e) {
        failCount++;
        if (e.isClientError) break;       // fall back to bypass
        if (failCount >= MAX_FAILURES) break;
      }

      if (Date.now() - startTime > 60 * 1000) break;   // give up on heartbeat after 1 min
      await sleep(rnd(19000, 22000));
    }
  } catch (_) { /* fall through */ }

  // Heartbeat didn't complete — try the bypass
  const r = await bypassAchievement(token, q, t);
  return r;
}

/**
 * GAME / STREAM handler — server-side, we can't fake a running game
 * process. The reference script patches the local Discord client's
 * RunningGameStore. Without that, the heartbeat event is never
 * triggered by Discord's server.
 *
 * We make a best-effort attempt with the discordsays bypass
 * (which doesn't depend on a local client). If that fails, the quest
 * can't be auto-completed from a bot context — the user would need to
 * run the original userscript inside their Discord desktop client.
 */
async function handleGameOrStream(token, q, t, onProgress) {
  // Try the discordsays bypass — same flow as ACHIEVEMENT
  const r = await bypassAchievement(token, q, t);
  if (r.ok) return r;

  // Last resort: try a heartbeat loop in case Discord accepts it for this quest type
  try {
    const channelId = String(rnd(100000000000000000, 999999999999999999));
    const streamKey = `call:${channelId}:${rnd(1000, 9999)}`;
    let cur = 0;
    let failCount = 0;
    const startTime = Date.now();
    while (cur < t.target) {
      try {
        const hb = await api.sendHeartbeat(token, q.id, streamKey, false);
        cur = hb.body?.progress?.[t.keyName]?.value ?? cur + 20;
        if (onProgress) onProgress({ questId: q.id, cur, max: t.target, type: t.type });
        failCount = 0;
        if (cur >= t.target) {
          try { await api.sendHeartbeat(token, q.id, streamKey, true); } catch (_) { }
          return { ok: true };
        }
      } catch (e) {
        failCount++;
        if (e.isClientError) break;
        if (failCount >= MAX_FAILURES) break;
      }
      if (Date.now() - startTime > 60 * 1000) break;
      await sleep(rnd(19000, 22000));
    }
  } catch (_) { /* fall through */ }

  return { ok: false, reason: `${t.type} quests require a local Discord client. Use the desktop userscript for these. (${r.reason})` };
}

/* ─────────────────────────────────────────────────────────────
   Public entry point
   ───────────────────────────────────────────────────────────── */

/**
 * Complete a single quest.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {object} opts.quest        Raw quest object from Discord API.
 * @param {function} [opts.onProgress]   Called with { questId, cur, max, type }.
 * @param {function} [opts.onLog]        Called with (message, level) for status updates.
 * @returns {Promise<{ok, reason?, calls?}>}
 */
async function completeQuest({ token, quest, onProgress, onLog }) {
  const q = normalizeQuest(quest);
  const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2 ?? q.config;
  if (!cfg?.tasks) {
    return { ok: false, reason: "Quest has no task config" };
  }

  const typeData = detectType(cfg, q.applicationId);
  if (!typeData) {
    return { ok: false, reason: "Unknown task type" };
  }
  if (typeData.target <= 0) {
    return { ok: false, reason: `Invalid target (${typeData.target})` };
  }

  const t = {
    id: q.id,
    appId: q.applicationId ?? 0,
    name: q.name,
    target: typeData.target,
    type: typeData.type,
    keyName: typeData.keyName
  };

  const emit = (msg, level = "info") => onLog && onLog(msg, level);

  // Auto-enroll if not already
  if (!q.enrolledAt) {
    emit(`Enrolling in "${t.name}"...`, "info");
    try {
      await api.enrollQuest(token, q.id);
      await sleep(rnd(800, 1500));
    } catch (e) {
      if (e.isClientError) {
        return { ok: false, reason: `Enrollment failed (HTTP ${e.status})` };
      }
      return { ok: false, reason: `Enrollment failed: ${e.message}` };
    }
  }

  emit(`Starting ${t.type} quest: ${t.name}`, "info");

  let result;
  switch (t.type) {
    case "WATCH_VIDEO":
      result = await handleVideo(token, q, t, onProgress);
      break;
    case "ACTIVITY":
      result = await handleActivity(token, q, t, onProgress);
      break;
    case "ACHIEVEMENT":
      result = await handleAchievement(token, q, t, onProgress);
      break;
    case "GAME":
    case "STREAM":
      result = await handleGameOrStream(token, q, t, onProgress);
      break;
    default:
      return { ok: false, reason: `Unsupported task type: ${t.type}` };
  }

  if (result.ok) {
    emit(`Completed "${t.name}"!`, "success");
  } else {
    emit(`Failed "${t.name}": ${result.reason}`, "error");
  }

  return result;
}

/**
 * Try to claim the reward for a completed quest.
 * Returns { ok, claimed, captchaRequired, reason }.
 */
async function claimQuestReward(token, questId) {
  try {
    const r = await api.claimReward(token, questId);
    if (r.body?.claimed_at) {
      return { ok: true, claimed: true };
    }
    return { ok: true, claimed: false, body: r.body };
  } catch (e) {
    const captcha = e.body?.captcha_key || e.body?.captcha_sitekey;
    if (captcha) {
      return { ok: false, claimed: false, captchaRequired: true, reason: "Captcha required — claim from the Discord app." };
    }
    return {
      ok: false, claimed: false,
      reason: e.body?.message || e.message || `HTTP ${e.status}`
    };
  }
}

module.exports = {
  completeQuest,
  claimQuestReward,
  detectType,
  normalizeQuest,
  isQuestActive
};
