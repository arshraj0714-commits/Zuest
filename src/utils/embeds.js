/* ─────────────────────────────────────────────────────────────
   embeds.js — themed embed builders for Zuest
   ───────────────────────────────────────────────────────────── */
"use strict";

const { EmbedBuilder } = require("discord.js");

const THEME = {
  blurple: "#5865F2",
  success: "#3BA55C",
  warn:    "#faa61a",
  err:     "#f04747",
  neutral: "#2b2d31"
};

const FOOTER = { text: "Zuest • Discord Quest Completer" };

function base(color, title, description) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title || null)
    .setDescription(description || null)
    .setFooter(FOOTER)
    .setTimestamp();
}

module.exports = {
  THEME,
  info:     (title, desc)    => base(THEME.blurple, title, desc),
  success:  (title, desc)    => base(THEME.success, title, desc),
  warn:     (title, desc)    => base(THEME.warn,    title, desc),
  error:    (title, desc)    => base(THEME.err,     title, desc),
  neutral:  (title, desc)    => base(THEME.neutral, title, desc),
  /**
   * Build a paginated embed listing of quests.
   * @param {Array} quests   Already-normalized quest objects.
   * @param {string} title
   */
  questList: (quests, title = "Available Quests") => {
    const embed = base(THEME.blurple, title);
    if (!quests.length) {
      embed.setDescription("No active quests found. Check back later — Discord adds new ones weekly.");
      return embed;
    }
    const lines = quests.map((q, i) => {
      const type = q.type || "Unknown";
      const reward = q.reward || "";
      return `**${i + 1}. ${q.name}**\n   Type: \`${type}\` • ID: \`${q.id}\`${reward ? ` • Reward: ${reward}` : ""}`;
    });
    // Embed description max is 4096; chunk if needed
    const chunks = [];
    let cur = "";
    for (const line of lines) {
      if ((cur + "\n" + line).length > 4000) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? `${cur}\n${line}` : line;
      }
    }
    if (cur) chunks.push(cur);
    embed.setDescription(chunks[0]);
    embed.setFooter({ ...FOOTER, text: `${FOOTER.text} • Showing ${quests.length} quest(s)` });
    return embed;
  }
};
