'use strict';

/**
 * Normalized sample history, persisted as plain JSON under userData.
 * Stores ONLY: provider id, window id, sample time, percentage, reset
 * timestamp, provider state. Capped and pruned (48h) so it stays small.
 */
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 48 * 3600_000;
const MAX_SAMPLES_PER_WINDOW = 288; // 24h at a 5-minute cadence
const MAX_TOTAL_SAMPLES = 2000;

class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Record<string, Array<{t:number,percent:number,resetsAt:string|null,state:string}>>} */
    this.data = {};
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, samples] of Object.entries(raw)) {
          if (typeof key !== 'string' || !Array.isArray(samples)) continue;
          this.data[key] = samples.filter((s) => s && Number.isFinite(s.t));
        }
      }
    } catch { /* absent or corrupt: start empty */ }
    return this.data;
  }

  key(providerId, windowId) {
    return `${providerId}:${windowId}`;
  }

  /** Append a normalized sample. `state`: 'ok' | 'error'. */
  append(providerId, windowId, sample) {
    const key = this.key(providerId, windowId);
    const arr = this.data[key] || (this.data[key] = []);
    arr.push({
      t: sample.t,
      percent: sample.percent === null || sample.percent === undefined ? null : Number(sample.percent),
      resetsAt: sample.resetsAt === undefined ? null : sample.resetsAt,
      state: sample.state === 'error' ? 'error' : 'ok',
    });
    if (arr.length > MAX_SAMPLES_PER_WINDOW) arr.splice(0, arr.length - MAX_SAMPLES_PER_WINDOW);
  }

  get(providerId, windowId) {
    return this.data[this.key(providerId, windowId)] || [];
  }

  /** Prune old samples globally; enforce a total cap. */
  prune(now = Date.now()) {
    for (const key of Object.keys(this.data)) {
      this.data[key] = this.data[key].filter((s) => now - s.t <= MAX_AGE_MS);
      if (this.data[key].length === 0) delete this.data[key];
    }
    let total = Object.values(this.data).reduce((n, a) => n + a.length, 0);
    if (total > MAX_TOTAL_SAMPLES) {
      for (const key of Object.keys(this.data)) {
        const drop = Math.min(this.data[key].length, total - MAX_TOTAL_SAMPLES);
        if (drop > 0) {
          this.data[key].splice(0, drop);
          total -= drop;
          if (this.data[key].length === 0) delete this.data[key];
        }
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
  }
}

/**
 * Ingest a provider snapshot into history: one sample per window (only
 * session/weekly participate in spike detection; 'other' windows are skipped
 * to keep history minimal, since Mini mode doesn't render them).
 */
function ingestSnapshot(history, snapshot, now = Date.now()) {
  if (!snapshot || !snapshot.ok) {
    // Provider-level failure: record an error sample on existing windows so
    // recovery is detectable. Nothing invented for unknown windows.
    for (const key of Object.keys(history.data)) {
      if (key.startsWith(`${snapshot && snapshot.providerId}:`)) {
        const [pid, wid] = key.split(':');
        const prev = history.get(pid, wid).slice(-1)[0];
        history.append(pid, wid, { t: now, percent: prev ? prev.percent : null, resetsAt: prev ? prev.resetsAt : null, state: 'error' });
      }
    }
    return;
  }
  const seen = new Set();
  for (const w of snapshot.windows) {
    if (w.kind !== 'session' && w.kind !== 'weekly') continue;
    const wid = w.kind;
    seen.add(wid);
    history.append(snapshot.providerId, wid, { t: now, percent: w.usedPercent, resetsAt: w.resetsAt, state: 'ok' });
  }
}

module.exports = { HistoryStore, ingestSnapshot, MAX_AGE_MS };
