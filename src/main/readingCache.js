'use strict';

// Last successful quota readings only. Explicit field selection keeps raw
// responses, credentials, errors, and arbitrary diagnostic notes off disk.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { WINDOW_KINDS } = require('./providers/model');

const CLAUDE_SOURCE_NOTE = 'From Claude Code status line';

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
      // Z.ai's web-search allowance uses these normalized numeric fields.
      for (const key of ['usedValue', 'limitValue']) {
        if (Number.isFinite(w[key]) && w[key] >= 0) window[key] = w[key];
      }
      return window;
    });
  const local = snap.source === 'claude-statusline'
    || (Array.isArray(snap.notes) && snap.notes.includes(CLAUDE_SOURCE_NOTE));
  return {
    providerId: id,
    ok: true,
    plan: text(snap.plan, 40),
    windows,
    notes: local ? [CLAUDE_SOURCE_NOTE] : [],
    ...(local ? { source: 'claude-statusline' } : {}),
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx');
    created = true;
    fs.writeFileSync(descriptor, data, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try { fs.unlinkSync(temporaryPath); } catch { /* renamed, or cleanup unavailable */ }
    }
  }
}

module.exports = { safeReading, loadReadings, saveReadings };
