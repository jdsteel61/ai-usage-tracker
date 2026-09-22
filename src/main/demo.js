'use strict';

/**
 * Demo mode: builds a synthetic live-looking snapshot from test fixtures so
 * the UI (and screenshot tooling) can render without any real account or
 * credential. Contains no secrets; all numbers are invented.
 */
const fs = require('fs');

function loadDemoSnapshots(fixturePath, now = Date.now()) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const min = 60_000;
  const offsets = {
    codex: { session: 2 * 60 * min, weekly: 4 * 24 * 60 * min },
    claude: { session: 38 * min, weekly: 2 * 24 * 60 * min },
    zai: { session: 3 * 60 * min, weekly: 5 * 24 * 60 * min },
  };
  const out = {};
  for (const [id, snap] of Object.entries(raw)) {
    const windows = (snap.windows || []).map((w) => {
      const off = offsets[id] && offsets[id][w.kind];
      return { ...w, resetsAt: off ? new Date(now + off).toISOString() : w.resetsAt };
    });
    out[id] = { ...snap, windows, fetchedAt: now - 30_000, stale: false };
  }
  return out;
}

module.exports = { loadDemoSnapshots };
