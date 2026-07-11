/* ─────────────────────────────────────────────────────────────
   fuzzy.js — lightweight fuzzy match for quest names.

   Returns a score (0 means no match). Higher = better match.
   Perfect substring matches dominate; otherwise we use a
   Levenshtein-style distance with length penalty.
   ───────────────────────────────────────────────────────────── */
"use strict";

function levenshtein(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Returns a score for how well `candidate` matches `query`.
 * 0 = no match. Higher = better.
 */
function scoreMatch(query, candidate) {
  if (!query || !candidate) return 0;
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (!q || !c) return 0;

  // Exact match
  if (q === c) return 1000;

  // Substring match (query inside candidate)
  const idx = c.indexOf(q);
  if (idx >= 0) return 800 - idx;

  // Every word in query appears in candidate (in any order)
  const qWords = q.split(/\s+/);
  const allPresent = qWords.every(w => c.includes(w));
  if (allPresent) return 600;

  // Levenshtein-based score
  const dist = levenshtein(q, c);
  const maxLen = Math.max(q.length, c.length);
  return Math.max(0, Math.round((1 - dist / maxLen) * 500));
}

/**
 * Find the best match in a list of candidates.
 * Returns { item, score } or null if no match above the threshold.
 */
function findBest(query, items, getLabel = (x) => String(x)) {
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const s = scoreMatch(query, getLabel(item));
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  // Threshold: below 200 is probably a wrong match
  if (bestScore < 200) return null;
  return { item: best, score: bestScore };
}

module.exports = { scoreMatch, findBest, levenshtein };
