'use strict';

// Last successful quota readings only. Explicit field selection keeps raw
// responses, credentials, errors, and arbitrary diagnostic notes off disk.
const fs = require('fs');
const { writeFileAtomic } = require('./atomicWrite');
const { WINDOW_KINDS, CLAUDE_LOCAL_NOTE, CLAUDE_API_NOTE } = require('./providers/model');

function text(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : null;
}

function safeReading(id, snap) {
  if (!snap || snap.ok !== true || !Number.isFinite(snap.fetchedAt)
      || snap.fetchedAt < 0 || snap.fetchedAt > 8.64e15) return null;
  const windows = (Array.isArray(snap.windows) ? snap.windows : []).slice(0, 64)
    .filter((w) => w && WINDOW_KINDS.includes(w.kind)
      && (w.usedPercent === null || (Number.isFinite(w.usedPercent)
        && w.usedPercent >= 0 && w.usedPercent <= 100)))
    .map((w, index) => {
      const reset = typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) : NaN;
      const window = {
        id: text(w.id, 120) || `${id}:${w.kind}:${index}`,
        kind: w.kind,
        label: text(w.label, 60) || '',
        usedPercent: w.usedPercent,
        resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
        periodSeconds: Number.isFinite(w.periodSeconds) && w.periodSeconds > 0 ? w.periodSeconds : null,
      };
      // Claude windows keep their own observation time so merges stay per window.
      if (Number.isFinite(w.observedAt) && w.observedAt >= 0 && w.observedAt <= 8.64e15) window.observedAt = w.observedAt;
      // Z.ai's web-search allowance uses these normalized numeric fields.
      for (const key of ['usedValue', 'limitValue']) {
        if (Number.isFinite(w[key]) && w[key] >= 0) window[key] = w[key];
      }
      return window;
    });
  const noted = (note) => Array.isArray(snap.notes) && snap.notes.includes(note);
  const api = snap.source === 'claude-api' || noted(CLAUDE_API_NOTE);
  const local = !api && (snap.source === 'claude-statusline' || noted(CLAUDE_LOCAL_NOTE));
  return {
    providerId: id,
    ok: true,
    plan: text(snap.plan, 40),
    windows,
    notes: local ? [CLAUDE_LOCAL_NOTE] : api ? [CLAUDE_API_NOTE] : [],
    ...(local ? { source: 'claude-statusline' } : api ? { source: 'claude-api' } : {}),
    fetchedAt: snap.fetchedAt,
    stale: true,
  };
}

function normalizedReadings(readings, allowedIds) {
  const entries = [];
  if (!readings || typeof readings !== 'object' || Array.isArray(readings)) return {};
  for (const id of new Set(allowedIds)) {
    if (typeof id !== 'string' || !Object.hasOwn(readings, id)) continue;
    const safe = safeReading(id, readings[id]);
    if (safe) entries.push([id, safe]);
  }
  return Object.fromEntries(entries);
}

/** Missing or damaged caches start empty. Also accepts the legacy Claude map. */
function loadReadings(filePath, allowedIds) {
  try {
    return normalizedReadings(JSON.parse(fs.readFileSync(filePath, 'utf8')), allowedIds);
  } catch { return {}; }
}

/** Pass all configured IDs, including disabled providers, to preserve their last readings. */
function saveReadings(filePath, readings, allowedIds) {
  const data = JSON.stringify(normalizedReadings(readings, allowedIds));
  writeFileAtomic(filePath, data);
}

module.exports = { safeReading, loadReadings, saveReadings };
