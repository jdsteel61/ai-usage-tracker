'use strict';

/**
 * Per-window freshness for Claude readings. Session and weekly windows each
 * carry their own observation time, and the newest observation of each wins,
 * whichever source (local capture, API top-up, stored reading) it came from.
 * Pure functions; shared by the Claude adapter and by main.js, which uses them
 * to make sure a late result never overwrites a newer observation.
 */
const { CLAUDE_API_NOTE } = require('./providers/model');

const LOCAL_STALE_MS = 15 * 60_000;
const API_STALE_MS = 35 * 60_000; // top-up runs after 25 minutes, so allow it to land
const KINDS = ['session', 'weekly'];

const isModelWindow = (w) => !!w && w.kind === 'other' && typeof w.id === 'string' && w.id.startsWith('claude:model:');

function isApiReading(snap) {
  return snap.source === 'claude-api' || (Array.isArray(snap.notes) && snap.notes.includes(CLAUDE_API_NOTE));
}

function observedAt(snap, w) {
  return Number.isFinite(w.observedAt) ? w.observedAt : snap.fetchedAt;
}

function staleLimit(snap) { return isApiReading(snap) ? API_STALE_MS : LOCAL_STALE_MS; }

/** `snaps` in ascending priority: on equal observation times the later one wins.
 * Returns one of the inputs when it already holds every chosen window, so
 * unchanged readings keep their identity; otherwise a combined snapshot whose
 * fetchedAt is its oldest window's observation. Null when none is usable. */
function mergeClaudeReadings(snaps, now = Date.now()) {
  const usable = snaps.filter((s) => s && s.ok && Array.isArray(s.windows));
  const chosen = [];
  for (const kind of KINDS) {
    let best = null;
    for (const snap of usable) {
      for (const w of snap.windows) {
        if (!w || w.kind !== kind) continue;
        const at = observedAt(snap, w);
        if (!best || at >= best.at) best = { snap, w, at };
      }
    }
    if (best) chosen.push(best);
  }
  if (!chosen.length) return null;
  // Model-specific weekly limits come only from the API: keep the newest
  // observation of each while its reset is ahead and it is within the API
  // stale cutoff, so local capture never deletes them. They never set freshness.
  const models = new Map();
  for (const snap of usable) {
    for (const w of snap.windows) {
      if (!isModelWindow(w)) continue;
      const at = observedAt(snap, w);
      if (!(Date.parse(w.resetsAt) > now) || now - at > API_STALE_MS || at > now) continue;
      const have = models.get(w.id);
      if (!have || at >= have.at) models.set(w.id, { snap, w, at });
    }
  }
  const core = chosen.slice();
  chosen.push(...models.values());
  const owners = new Set(chosen.map((c) => c.snap));
  if (owners.size === 1) {
    const [only] = owners;
    if (only.windows.filter((w) => w && (KINDS.includes(w.kind) || isModelWindow(w))).length === chosen.length) return only;
  }
  const oldest = core.reduce((a, b) => (b.at < a.at ? b : a));
  const newest = core.reduce((a, b) => (b.at > a.at ? b : a));
  const base = oldest.snap;
  return {
    ...base,
    plan: newest.snap.plan || base.plan || null,
    windows: chosen.map(({ w, at }) => ({ ...w, observedAt: at })),
    fetchedAt: oldest.at,
    stale: false,
  };
}

/** Commit-time check for a result that was computed while other readings
 * arrived: keep every window whose stored observation is newer. */
function reconcileClaudeReadings(existing, incoming, now = Date.now()) {
  if (!incoming || !incoming.ok || !existing || !existing.ok) return incoming;
  const merged = mergeClaudeReadings([existing, incoming], now);
  if (merged === incoming || !merged) return incoming;
  if (merged === existing) return existing;
  const rest = { ...merged };
  delete rest.lastError;
  return { ...rest, stale: now - merged.fetchedAt > staleLimit(merged) || !!incoming.lastError,
    ...(incoming.lastError ? { lastError: incoming.lastError } : {}) };
}

/** Fair processing order: the account whose newest data is oldest goes first,
 * ties broken by who was attempted least recently. `lastAttempt(id)` is any
 * comparable number (-Infinity for never). */
function orderByObservationAge(ids, readings, lastAttempt = () => -Infinity) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const age = (id) => (readings[id] && readings[id].ok && Number.isFinite(readings[id].fetchedAt) ? readings[id].fetchedAt : 0);
  return [...ids].sort((a, b) => compare(age(a), age(b)) || compare(lastAttempt(a), lastAttempt(b)));
}

module.exports = { orderByObservationAge, mergeClaudeReadings, reconcileClaudeReadings, isApiReading, staleLimit, LOCAL_STALE_MS, API_STALE_MS };
