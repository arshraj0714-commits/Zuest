/* ─────────────────────────────────────────────────────────────
   logger.js — tiny leveled logger with ANSI colors
   ───────────────────────────────────────────────────────────── */
"use strict";

const isDebug = (process.env.DEBUG || "").toLowerCase() === "true";

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function fmt(level, color, msg, meta) {
  const base = `${COLORS.gray}${ts()}${COLORS.reset} ${color}[${level}]${COLORS.reset} ${msg}`;
  if (meta !== undefined) {
    let metaStr;
    try {
      metaStr = typeof meta === "string" ? meta : JSON.stringify(meta);
    } catch (_) {
      metaStr = String(meta);
    }
    return `${base}\n${COLORS.gray}${metaStr}${COLORS.reset}`;
  }
  return base;
}

module.exports = {
  info:  (msg, meta) => console.log(fmt("INFO ", COLORS.cyan,   msg, meta)),
  warn:  (msg, meta) => console.warn(fmt("WARN ", COLORS.yellow, msg, meta)),
  error: (msg, meta) => console.error(fmt("ERROR", COLORS.red,    msg, meta)),
  success: (msg, meta) => console.log(fmt(" OK  ", COLORS.green,  msg, meta)),
  debug: (msg, meta) => { if (isDebug) console.log(fmt("DEBUG", COLORS.magenta, msg, meta)); }
};
