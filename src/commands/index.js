/* ─────────────────────────────────────────────────────────────
   commands/index.js — exports every command handler

   Each command is an async function(message, args, ctx) where ctx is:
     { bot, tokenStore, prefix, isDm, allowedUserIds }
   ───────────────────────────────────────────────────────────── */
"use strict";

const log = require("../core/logger");
const api = require("../core/discordApi");
const qc = require("../core/questCompleter");
const embeds = require("../utils/embeds");
const fuzzy = require("../utils/fuzzy");

// Discord user-token regex — used for safety auto-delete in servers.
// Tokens look like: 3 base64-ish segments separated by dots.
const TOKEN_RE = /([A-Za-z0-9_\-]{20,})\.([A-Za-z0-9_\-]{4,})\.([A-Za-z0-9_\-]{20,})/;

/* ─── helpers ───────────────────────────────────────────────── */

async function reply(message, embed, options = {}) {
  try {
    return await message.reply({ embeds: [embed], ...options });
  } catch (e) {
    log.debug(`reply failed: ${e.message}`);
    return null;
  }
}

async function dm(user, embed, options = {}) {
  try {
    return await user.send({ embeds: [embed], ...options });
  } catch (e) {
    log.debug(`dm failed: ${e.message}`);
    return null;
  }
}

function isAllowed(ctx, userId) {
  if (!ctx.allowedUserIds || ctx.allowedUserIds.length === 0) return true;
  return ctx.allowedUserIds.includes(userId);
}

/* ─── ;link ─────────────────────────────────────────────────── */

async function linkCommand(message, args, ctx) {
  const userId = message.author.id;

  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }

  // If invoked in a server, redirect to DMs for privacy.
  if (message.guild) {
    await reply(message, embeds.info("Check your DMs 📬", "I've sent you a private message to link your token safely."));
    const opened = await dm(message.author, embeds.info(
      "Link your Discord account",
      `Hi ${message.author.username}! Send me your **Discord user token** here in DMs to link your account.\n\n` +
      `**How to get your token:**\n` +
      `1. Open Discord in your browser (desktop app won't work).\n` +
      `2. Press \`F12\` to open DevTools.\n` +
      `3. Go to **Network** tab, then reload Discord.\n` +
      `4. Find any request to \`discord.com\` and look at the **Request Headers**.\n` +
      `5. Copy the value of the \`Authorization\` header — that's your token.\n\n` +
      `⚠️ **Never share this token with anyone.** It gives full access to your account.\n` +
      `Type \`cancel\` to abort.`
    ));
    if (!opened) {
      return reply(message, embeds.warn("DMs closed", "I couldn't DM you. Please enable DMs from server members and try again."));
    }
    ctx.linkSession.start(userId);
    return;
  }

  // In DMs already — start the link session directly.
  await dm(message.author, embeds.info(
    "Link your Discord account",
    `Send me your **Discord user token** in your next message.\n\n` +
    `**How to get your token:**\n` +
    `1. Open Discord in your browser (desktop app won't work).\n` +
    `2. Press \`F12\` to open DevTools.\n` +
    `3. Go to **Network** tab, then reload Discord.\n` +
    `4. Find any request to \`discord.com\` and look at the **Request Headers**.\n` +
    `5. Copy the value of the \`Authorization\` header — that's your token.\n\n` +
    `⚠️ **Never share this token with anyone.** It gives full access to your account.\n` +
    `Type \`cancel\` to abort.`
  ));
  ctx.linkSession.start(userId);
}

/* ─── ;unlink ───────────────────────────────────────────────── */

async function unlinkCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const removed = ctx.tokenStore.unlink(userId);
  if (removed) {
    return reply(message, embeds.success("Unlinked ✅", "Your Discord account has been unlinked and your token removed from storage."));
  }
  return reply(message, embeds.warn("Nothing to unlink", "You don't have a linked account."));
}

/* ─── ;quests ───────────────────────────────────────────────── */

async function questsCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const token = ctx.tokenStore.getToken(userId);
  if (!token) {
    return reply(message, embeds.warn("Not linked", `Run \`${ctx.prefix}link\` first to link your Discord account.`));
  }

  const statusMsg = await reply(message, embeds.info("Fetching quests...", "Querying `/quests/@me` on Discord's API..."));

  try {
    const { quests: questsRaw, raw } = await api.getQuests(token, { returnMeta: true });

    // The gateway may return an array OR an object with quest values
    let questsArray = questsRaw;
    if (!Array.isArray(questsRaw)) {
      if (questsRaw && typeof questsRaw === "object") {
        if (Array.isArray(questsRaw.quests)) questsArray = questsRaw.quests;
        else if (Array.isArray(questsRaw.user_quests)) questsArray = questsRaw.user_quests;
        else if (Array.isArray(questsRaw.assignments)) questsArray = questsRaw.assignments;
        else questsArray = Object.values(questsRaw).filter(v => v && (v.id || v.quest_id));
      } else {
        return statusMsg?.edit({ embeds: [embeds.error("Unexpected response", `Discord returned a ${typeof questsRaw} response.`)] });
      }
    }

    if (!questsArray.length) {
      // Build a detailed explanation. Include the raw response so the user
      // can see for themselves that Discord genuinely returned no quests.
      const blockedUntil = raw?.quest_enrollment_blocked_until;
      const excludedCount = raw?.excluded_quests?.length ?? 0;
      let desc = "Discord's `/quests/@me` endpoint returned successfully, but your account has **0 active quests**.\n\n";
      desc += "**This is NOT a bot error** — Discord genuinely hasn't assigned any quests to this account.\n\n";
      desc += "**Common reasons:**\n";
      desc += "• The account is too new (Discord requires accounts to be active for weeks/months before assigning quests)\n";
      desc += "• The account hasn't used the Discord **desktop client** recently (quests are targeted at desktop users)\n";
      desc += "• The account doesn't have **Nitro** (some quests are Nitro-only)\n";
      desc += "• Region restrictions — quests aren't available in all countries\n";
      desc += "• Email not verified, or account flagged for suspicious activity\n\n";
      desc += `**Raw response from Discord:**\n\`\`\`json\n${JSON.stringify(raw, null, 2).slice(0, 1000)}\n\`\`\`\n`;
      if (blockedUntil) {
        desc += `\n⚠️ **Quest enrollment blocked until:** ${blockedUntil}`;
      }
      if (excludedCount > 0) {
        desc += `\n📋 **Excluded quests:** ${excludedCount} (Discord has excluded these from your account)`;
      }
      desc += `\n\n💡 **Try linking your MAIN Discord account** — the one where you can actually see quests in the Discord app.`;
      return statusMsg?.edit({ embeds: [embeds.warn("No quests on this account", desc)] });
    }

    const normalized = questsArray.map(qc.normalizeQuest);
    const active = normalized.filter(qc.isQuestActive);

    if (!active.length) {
      return statusMsg?.edit({ embeds: [embeds.success("All done! 🎉", `Received ${questsArray.length} quest(s) from Discord, but all are completed or expired. Check back later.`)] });
    }

    // Detect each quest's type for display
    const withType = active.map(q => {
      const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2 ?? q.config;
      const typeData = qc.detectType(cfg, q.applicationId);
      return {
        id: q.id,
        name: q.name,
        type: typeData?.type || "Unknown",
        target: typeData?.target || 0,
        reward: q.config?.messages?.rewardHeader || ""
      };
    });

    const listEmbed = embeds.questList(withType, `Active Quests (${withType.length})`);
    await statusMsg?.edit({ embeds: [listEmbed] });
  } catch (e) {
    log.error(`questsCommand failed: ${e.message}`);
    const msg = e.message || "Unknown error";
    if (/invalid|auth|rejected|4004/i.test(msg)) {
      await statusMsg?.edit({ embeds: [embeds.error("Token invalid", `Discord rejected your token: \`${msg}\`\n\nRun \`${ctx.prefix}unlink\` then \`${ctx.prefix}link\` again with a fresh token.`)] });
    } else if (/timeout/i.test(msg)) {
      await statusMsg?.edit({ embeds: [embeds.warn("Timed out", "The request took too long. Try again in a moment.")] });
    } else {
      await statusMsg?.edit({ embeds: [embeds.error("Failed to fetch quests", `\`${msg}\``)] });
    }
  }
}

/* ─── ;quest <name> ─────────────────────────────────────────── */

async function questCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const token = ctx.tokenStore.getToken(userId);
  if (!token) {
    return reply(message, embeds.warn("Not linked", `Run \`${ctx.prefix}link\` first.`));
  }

  const query = args.join(" ").trim();
  if (!query) {
    return reply(message, embeds.warn("Missing quest name", `Usage: \`${ctx.prefix}quest <name>\`\nExample: \`${ctx.prefix}quest Watch a Video\``));
  }

  const statusMsg = await reply(message, embeds.info("Looking up quest...", `Searching for: \`${query}\`\n\nConnecting to Discord gateway (~5-10s)...`));

  try {
    const questsRaw = await api.getQuests(token);

    // Normalize — gateway may return array or object
    let questsArray = questsRaw;
    if (!Array.isArray(questsRaw)) {
      if (questsRaw && typeof questsRaw === "object") {
        if (Array.isArray(questsRaw.quests)) questsArray = questsRaw.quests;
        else if (Array.isArray(questsRaw.user_quests)) questsArray = questsRaw.user_quests;
        else questsArray = Object.values(questsRaw).filter(v => v && (v.id || v.quest_id));
      } else {
        return statusMsg?.edit({ embeds: [embeds.error("Unexpected response", `Discord returned a ${typeof questsRaw} response.`)] });
      }
    }

    const normalized = questsArray.map(qc.normalizeQuest);
    const active = normalized.filter(qc.isQuestActive);

    if (!active.length) {
      return statusMsg?.edit({ embeds: [embeds.success("No active quests", "Nothing to complete right now.")] });
    }

    // Fuzzy-match by name first, then by ID
    let target = active.find(q => q.id === query);
    if (!target) {
      const match = fuzzy.findBest(query, active, q => q.name);
      target = match?.item;
    }

    if (!target) {
      return statusMsg?.edit({ embeds: [embeds.warn("No match", `Couldn't find an active quest matching \`${query}\`. Run \`${ctx.prefix}quests\` to see available quests.`)] });
    }

    // Start completion
    await statusMsg?.edit({ embeds: [embeds.info("Starting...", `**${target.name}** (\`${target.id}\`)\nType: \`${qc.detectType(target.config?.taskConfig ?? target.config?.taskConfigV2 ?? target.config, target.applicationId)?.type || "Unknown"}\``)] });

    const result = await qc.completeQuest({
      token,
      quest: target,
      onProgress: ({ cur, max, type }) => {
        const pct = max > 0 ? Math.min(100, Math.floor((cur / max) * 100)) : 0;
        log.debug(`[Progress] ${target.name}: ${cur}/${max} (${pct}%)`);
      },
      onLog: (msg, level) => log.info(`[Quest:${target.id}] ${msg}`)
    });

    if (result.ok) {
      // Try to auto-claim
      const claim = await qc.claimQuestReward(token, target.id);
      if (claim.claimed) {
        return statusMsg?.edit({ embeds: [embeds.success("Quest completed & reward claimed! 🎁", `**${target.name}**\nQuest finished and reward claimed automatically.`)] });
      }
      return statusMsg?.edit({ embeds: [embeds.success("Quest completed ✅", `**${target.name}**\n${claim.captchaRequired ? "⚠️ Captcha required — claim the reward from the Discord app." : "Reward not auto-claimed. Run `" + ctx.prefix + "claim " + target.id + "` to try again."}`)] });
    }
    return statusMsg?.edit({ embeds: [embeds.error("Quest failed", `**${target.name}**\n\`${result.reason}\``)] });
  } catch (e) {
    log.error(`questCommand failed: ${e.message}`);
    const msg = e.message || "Unknown error";
    if (/invalid|auth|rejected|4004/i.test(msg)) {
      return statusMsg?.edit({ embeds: [embeds.error("Token invalid", `Discord rejected your token: \`${msg}\`\n\nRun \`${ctx.prefix}unlink\` then \`${ctx.prefix}link\` again.`)] });
    }
    return statusMsg?.edit({ embeds: [embeds.error("Failed", `\`${msg}\``)] });
  }
}

/* ─── ;questall ─────────────────────────────────────────────── */

async function questallCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const token = ctx.tokenStore.getToken(userId);
  if (!token) {
    return reply(message, embeds.warn("Not linked", `Run \`${ctx.prefix}link\` first.`));
  }

  const statusMsg = await reply(message, embeds.info("Fetching quests...", "Connecting to Discord gateway to fetch your quest list (~5-10s)..."));

  try {
    const questsRaw = await api.getQuests(token);

    // Normalize — gateway may return array or object
    let questsArray = questsRaw;
    if (!Array.isArray(questsRaw)) {
      if (questsRaw && typeof questsRaw === "object") {
        if (Array.isArray(questsRaw.quests)) questsArray = questsRaw.quests;
        else if (Array.isArray(questsRaw.user_quests)) questsArray = questsRaw.user_quests;
        else questsArray = Object.values(questsRaw).filter(v => v && (v.id || v.quest_id));
      } else {
        return statusMsg?.edit({ embeds: [embeds.error("Unexpected response", `Discord returned a ${typeof questsRaw} response.`)] });
      }
    }

    const normalized = questsArray.map(qc.normalizeQuest);
    const active = normalized.filter(qc.isQuestActive);

    if (!active.length) {
      return statusMsg?.edit({ embeds: [embeds.success("All done! 🎉", "No active quests remaining.")] });
    }

    await statusMsg?.edit({ embeds: [embeds.info("Working...", `Found ${active.length} active quest(s). Completing them sequentially...`)] });

    const results = [];
    for (let i = 0; i < active.length; i++) {
      const q = active[i];
      log.info(`[QuestAll] ${i + 1}/${active.length} — ${q.name}`);
      try {
        const r = await qc.completeQuest({
          token,
          quest: q,
          onLog: (msg, level) => log.info(`[QuestAll:${q.id}] ${msg}`)
        });
        results.push({ name: q.name, ok: r.ok, reason: r.reason });

        if (r.ok) {
          // Try claim
          const claim = await qc.claimQuestReward(token, q.id);
          results[results.length - 1].claimed = !!claim.claimed;
        }

        // Brief pause between quests to avoid rate limits
        if (i < active.length - 1) await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

      } catch (e) {
        results.push({ name: q.name, ok: false, reason: e.message });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed = results.length - succeeded;
    const claimed = results.filter(r => r.claimed).length;

    let desc = `**${succeeded}** completed • **${claimed}** rewards claimed • **${failed}** failed\n\n`;
    desc += results.map(r => {
      const icon = r.ok ? (r.claimed ? "🎁" : "✅") : "❌";
      return `${icon} ${r.name}${r.reason && !r.ok ? ` — \`${r.reason}\`` : ""}`;
    }).join("\n");

    return statusMsg?.edit({
      embeds: [failed > 0
        ? embeds.warn("Quest batch finished", desc)
        : embeds.success("Quest batch finished 🎉", desc)
      ]
    });
  } catch (e) {
    log.error(`questallCommand failed: ${e.message}`);
    return statusMsg?.edit({ embeds: [embeds.error("Failed", `\`${e.message}\` (HTTP ${e.status ?? "?"})`)] });
  }
}

/* ─── ;claim <questId> ──────────────────────────────────────── */

async function claimCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const token = ctx.tokenStore.getToken(userId);
  if (!token) {
    return reply(message, embeds.warn("Not linked", `Run \`${ctx.prefix}link\` first.`));
  }

  const questId = args[0];
  if (!questId) {
    return reply(message, embeds.warn("Missing quest ID", `Usage: \`${ctx.prefix}claim <questId>\``));
  }

  try {
    const r = await qc.claimQuestReward(token, questId);
    if (r.claimed) {
      return reply(message, embeds.success("Reward claimed 🎁", `Reward for quest \`${questId}\` has been claimed.`));
    }
    if (r.captchaRequired) {
      return reply(message, embeds.warn("Captcha required", "Discord is challenging this claim with a captcha. Open the Discord app and claim it from the Quests page."));
    }
    return reply(message, embeds.warn("Could not claim", `Quest \`${questId}\`: ${r.reason || "not claimable yet."}`));
  } catch (e) {
    return reply(message, embeds.error("Claim failed", `\`${e.message}\` (HTTP ${e.status ?? "?"})`));
  }
}

/* ─── ;status ───────────────────────────────────────────────── */

async function statusCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const info = ctx.tokenStore.getInfo(userId);
  if (!info) {
    return reply(message, embeds.warn("Not linked", `Run \`${ctx.prefix}link\` to link your account.`));
  }

  const created = new Date(info.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const lastUsed = info.last_used_at
    ? new Date(info.last_used_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "never";

  const embed = embeds.info("Account status", [
    `**User:** ${info.username || "Unknown"}${info.discriminator && info.discriminator !== "0" ? `#${info.discriminator}` : ""}`,
    `**Linked since:** ${created}`,
    `**Last used:** ${lastUsed}`,
    `**Linked accounts total:** ${ctx.tokenStore.count()}`
  ].join("\n"));

  return reply(message, embed);
}

/* ─── ;me ───────────────────────────────────────────────────── */

async function meCommand(message, args, ctx) {
  // Alias of status
  return statusCommand(message, args, ctx);
}

/* ─── ;debug ────────────────────────────────────────────────── */

async function debugCommand(message, args, ctx) {
  const userId = message.author.id;
  if (!isAllowed(ctx, userId)) {
    return reply(message, embeds.error("Not authorized", "You are not on the allowed users list."));
  }
  const token = ctx.tokenStore.getToken(userId);
  if (!token) {
    return reply(message, embeds.warn("Not linked", `Run \`${ctx.prefix}link\` first.`));
  }

  const subcommand = (args[0] || "quests").toLowerCase();
  const statusMsg = await reply(message, embeds.info("Debug — probing endpoints...", `Subcommand: \`${subcommand}\`\n\nThis will try every known quest endpoint on v9 and v10 and report what comes back. Share the result with the developer.`));

  try {
    if (subcommand === "quests" || subcommand === "endpoints") {
      // Probe endpoints
      const report = await api.probeQuestEndpoints(token);

      // Build a compact summary
      const lines = report.map(r => {
        const icon = r.ok ? "✅" : (r.status === 404 ? "⚫" : "❌");
        return `${icon} \`${r.endpoint}\` → ${r.status || "NET"} ${r.preview ? "\n   └ " + r.preview.slice(0, 150) : ""}`;
      });

      // Chunk into multiple embeds if too long
      const chunks = [];
      let cur = "";
      for (const line of lines) {
        if ((cur + "\n" + line).length > 3800) { chunks.push(cur); cur = line; }
        else { cur = cur ? cur + "\n" + line : line; }
      }
      if (cur) chunks.push(cur);

      // Send the first chunk as edit, rest as follow-up messages
      await statusMsg?.edit({
        embeds: [embeds.info("Debug — Quest Endpoint Probe", `Probed ${report.length} endpoint combinations.\n\n**Legend:** ✅ ok • ⚫ 404 (endpoint doesn't exist) • ❌ other error\n\n${chunks[0]}`)]
      });
      for (let i = 1; i < chunks.length; i++) {
        try {
          await message.channel.send({ embeds: [embeds.info(`Probe results (${i + 1}/${chunks.length})`, chunks[i])] });
        } catch (_) { /* ignore */ }
      }
      return;
    }

    if (subcommand === "me" || subcommand === "user") {
      const me = await api.getMe(token);
      const safe = {
        id: me.id,
        username: me.username,
        global_name: me.global_name,
        discriminator: me.discriminator,
        flags: me.flags,
        premium_type: me.premium_type,
        verified: me.verified
      };
      return statusMsg?.edit({
        embeds: [embeds.info("Debug — /users/@me response", "```json\n" + JSON.stringify(safe, null, 2) + "\n```")]
      });
    }

    if (subcommand === "force" || subcommand === "refresh") {
      // Force-refresh the quest cache
      const quests = await api.getQuests(token, { forceRefresh: true });
      return statusMsg?.edit({
        embeds: [embeds.info("Debug — force-refreshed quest cache", `Got ${quests.length} quest(s).\n\nFirst quest:\n\`\`\`json\n${quests[0] ? JSON.stringify(quests[0], null, 2).slice(0, 1500) : "(none)"}\n\`\`\``)]
      });
    }

    return statusMsg?.edit({
      embeds: [embeds.warn("Unknown debug subcommand", `Available: \`${ctx.prefix}debug quests\`, \`${ctx.prefix}debug me\`, \`${ctx.prefix}debug force\``)]
    });
  } catch (e) {
    log.error(`debugCommand failed: ${e.message}`);
    return statusMsg?.edit({ embeds: [embeds.error("Debug failed", `\`${e.message}\` (HTTP ${e.status ?? "?"})`)] });
  }
}

/* ─── ;help ─────────────────────────────────────────────────── */

async function helpCommand(message, args, ctx) {
  const p = ctx.prefix;
  const embed = embeds.info("Zuest — Command Reference", "Here are all available commands:");
  embed.addFields(
    { name: `${p}link`,        value: "Link your Discord account by sending your token in DMs.", inline: false },
    { name: `${p}unlink`,      value: "Remove your linked token from storage.", inline: false },
    { name: `${p}quests`,      value: "List all currently available (active, uncompleted) quests.", inline: false },
    { name: `${p}quest <name>`, value: "Complete a specific quest by name (fuzzy-matched) or ID.", inline: false },
    { name: `${p}questall`,    value: "Complete every active quest sequentially. Auto-claims rewards.", inline: false },
    { name: `${p}claim <id>`,  value: "Manually claim the reward for a completed quest.", inline: false },
    { name: `${p}status`,      value: "Show your linked-account info (alias: `;me`).", inline: false },
    { name: `${p}debug quests`, value: "Probe all known quest endpoints and report what each returns. Use this if `;quests` finds nothing.", inline: false },
    { name: `${p}help`,        value: "Show this message.", inline: false }
  );
  embed.addFields({
    name: "Notes",
    value: [
      "• Video quests are fully supported.",
      "• Activity & Achievement quests are supported (heartbeat + OAuth bypass).",
      "• Game / Stream quests need a real Discord desktop client — they cannot be auto-completed from a bot context.",
      "• Your token is AES-256 encrypted at rest if `TOKEN_ENCRYPTION_KEY` is set.",
      "• If `;quests` finds nothing, run `;debug quests` and share the output with the developer."
    ].join("\n")
  });
  return reply(message, embed);
}

/* ─── command registry ──────────────────────────────────────── */

module.exports = {
  link:     linkCommand,
  unlink:   unlinkCommand,
  quests:   questsCommand,
  quest:    questCommand,
  questall: questallCommand,
  claim:    claimCommand,
  status:   statusCommand,
  me:       meCommand,
  debug:    debugCommand,
  help:     helpCommand,
  TOKEN_RE
};
