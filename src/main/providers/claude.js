'use strict';

/** Read quota data captured from Claude Code's documented status-line input.
 * No credentials, network requests, or Claude prompts are used. */
const fs = require('fs');
const { usagePath } = require('../claudeStatusline');
const { okSnapshot, errorSnapshot } = require('./model');

function normalizeClaudeUsage(data, now = Date.now()) {
  const windows = [];
  const timestamps = [];
  for (const [key, kind, label, periodSeconds] of [
    ['five_hour', 'session', '5 hr', 5 * 3600],
    ['seven_day', 'weekly', 'Week', 7 * 24 * 3600],
  ]) {
    const w = data && data.windows && data.windows[key];
    if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
        || !Number.isFinite(w.observedAt) || w.observedAt > now
        || !(Date.parse(w.resetsAt) > now)) continue;
    windows.push({ id: `claude:${kind}`, kind, label, usedPercent: w.usedPercent,
      resetsAt: w.resetsAt, periodSeconds });
    timestamps.push(w.observedAt);
  }
  if (!windows.length) return errorSnapshot('claude', 'NO_DATA',
    'No current Claude usage captured. Enable local capture in Settings, then use Claude Code.');
  const fetchedAt = Math.min(...timestamps);
  return { ...okSnapshot('claude', { windows, fetchedAt, notes: ['From Claude Code status line'] }),
    stale: now - fetchedAt > 15 * 60_000 };
}

async function fetchClaudeQuotas(deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  let data;
  try { data = JSON.parse(read(deps.usagePath || usagePath(deps.configDir), 'utf8')); }
  catch { return errorSnapshot('claude', 'NO_DATA', 'Enable local capture in Settings, then use Claude Code to collect usage.'); }
  return normalizeClaudeUsage(data, deps.now ? deps.now() : Date.now());
}

module.exports = { fetchClaudeQuotas, normalizeClaudeUsage };
