'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectSpike, applyAlert, providerHasSpike, describeAlert, baselineRates, median } = require('../src/main/spikes');

const INTERVAL = 5 * 60_000; // 5-minute cadence
const T0 = 1_780_000_000_000;
const RESET = '2026-09-21T18:00:00.000Z';

function sample(t, percent, { resetsAt = RESET, state = 'ok' } = {}) {
  return { t, percent, resetsAt, state };
}

/** Baseline of calm history: +0.5 points per interval (6 pts/hour). */
function calmHistory(n, startPercent = 10, { gap = INTERVAL, from = T0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(sample(from + i * gap, startPercent + i * 0.5));
  return out;
}

const OPTS = { intervalMinutes: 5, absolutePoints: 8, relativePoints: 3, relativeMultiplier: 4 };

test('first sample is never flagged', () => {
  assert.equal(detectSpike('p', 'session', [sample(T0, 95)], OPTS, T0 + 1000), null);
});

test('normal growth is not flagged', () => {
  const h = calmHistory(10);
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('absolute spike: >= 8 points within one interval flags', () => {
  const h = calmHistory(10); // ends at ~14.5%
  h.push(sample(h.at(-1).t + INTERVAL, h.at(-1).percent + 9));
  const alert = detectSpike('p', 'session', h, OPTS, h.at(-1).t);
  assert.ok(alert);
  assert.equal(alert.kind, 'absolute');
  assert.equal(alert.deltaPoints, 9);
});

test('absolute spike just under threshold does not flag', () => {
  // Fast baseline (2 pts/interval) so the relative rule cannot fire either.
  const h = calmHistory(10, 10);
  for (let i = 0; i < h.length; i++) h[i].percent = 10 + i * 2;
  h.push(sample(h.at(-1).t + INTERVAL, h.at(-1).percent + 7.4));
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('deltas are normalized to the actual time between samples', () => {
  // 16 points across TWO intervals == 8 points per interval: flags.
  const h = calmHistory(10);
  const last = h.at(-1);
  h.push(sample(last.t + 2 * INTERVAL, last.percent + 16));
  const alert = detectSpike('p', 'session', h, OPTS, h.at(-1).t);
  assert.ok(alert, 'double-interval jump of 16 points normalizes to 8/interval');
  assert.equal(alert.kind, 'absolute');

  // 12 points across two intervals == 6/interval: below the absolute rule but
  // still a relative candidate; with a calm baseline it must flag relative.
  const h2 = calmHistory(10);
  const last2 = h2.at(-1);
  h2.push(sample(last2.t + 2 * INTERVAL, last2.percent + 12));
  const alert2 = detectSpike('p', 'session', h2, OPTS, h2.at(-1).t);
  assert.ok(alert2, 'relative rule applies with normalized rate');
  assert.equal(alert2.kind, 'relative');
});

test('relative spike: small delta but > 4x the 24h median rate flags', () => {
  // Calm baseline: +0.2 points/interval = 2.4 pts/hour.
  const h = calmHistory(24, 10, { });
  for (const s of h) s.percent = 10 + (s.t - T0) / INTERVAL * 0.2;
  const last = h.at(-1);
  // Jump of 3.5 points in one interval = 42 pts/hour >> 4 x 2.4.
  h.push(sample(last.t + INTERVAL, last.percent + 3.5));
  const alert = detectSpike('p', 'session', h, OPTS, h.at(-1).t);
  assert.ok(alert);
  assert.equal(alert.kind, 'relative');
  assert.equal(alert.deltaPoints, 3.5);
});

test('relative spike below the minimum delta does not flag', () => {
  const h = calmHistory(24);
  for (const s of h) s.percent = 10 + (s.t - T0) / INTERVAL * 0.2;
  const last = h.at(-1);
  h.push(sample(last.t + INTERVAL, last.percent + 2)); // >= 3 required even at high rate
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('quota reset (usage drop) is not flagged', () => {
  const h = calmHistory(10);
  const last = h.at(-1);
  h.push(sample(last.t + INTERVAL, 3)); // dropped
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('quota reset (same percent, new reset timestamp) is not flagged', () => {
  const h = calmHistory(10);
  const last = h.at(-1);
  const fresh = sample(last.t + INTERVAL, last.percent + 1);
  fresh.resetsAt = '2026-09-22T03:00:00.000Z';
  h.push(fresh);
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('long gap (> 3 polling intervals) is not flagged', () => {
  const h = calmHistory(10);
  const last = h.at(-1);
  h.push(sample(last.t + 4 * INTERVAL, last.percent + 40));
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('recovery from stale/error state is not flagged', () => {
  const h = calmHistory(10);
  const last = h.at(-1);
  const errSample = sample(last.t + INTERVAL, last.percent, { state: 'error' });
  const recovered = sample(last.t + 2 * INTERVAL, last.percent + 15); // resume with a jump
  h.push(errSample, recovered);
  assert.equal(detectSpike('p', 'session', h, OPTS, h.at(-1).t), null);
});

test('zero and flat histories never flag', () => {
  const flat = Array.from({ length: 12 }, (_, i) => sample(T0 + i * INTERVAL, 0));
  assert.equal(detectSpike('p', 'session', flat, OPTS, flat.at(-1).t), null);
  const flat50 = Array.from({ length: 12 }, (_, i) => sample(T0 + i * INTERVAL, 50));
  assert.equal(detectSpike('p', 'session', flat50, OPTS, flat50.at(-1).t), null);
});

test('baseline rates exclude resets, errors, and long gaps', () => {
  const h = [
    sample(T0, 10),
    sample(T0 + INTERVAL, 10.5), // pair (0->1): usable
    sample(T0 + 2 * INTERVAL, 2), // reset: pair (1->2) excluded (drop)
    sample(T0 + 3 * INTERVAL, 30, { state: 'ok' }), // pair (2->3): same window, kept
    sample(T0 + 4 * INTERVAL, 30.5, { state: 'error' }), // pairs touching error excluded
    sample(T0 + 10 * INTERVAL, 31), // pair (4->5): long gap, excluded
    sample(T0 + 11 * INTERVAL, 31.5), // pair (5->6): usable
  ];
  const rates = baselineRates(h, INTERVAL, T0 + 12 * INTERVAL);
  assert.equal(rates.length, 3, 'only clean consecutive pairs feed the baseline');
});

test('median helper', () => {
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 9, 5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('alerts persist for the configured duration then expire', () => {
  const now = T0;
  const alert = { providerId: 'claude', windowId: 'session', kind: 'absolute', deltaPoints: 11, fromT: now - INTERVAL, toT: now };
  let active = applyAlert({}, alert, 30, now);
  assert.equal(providerHasSpike(active, 'claude', now + 29 * 60_000), true);
  assert.equal(providerHasSpike(active, 'claude', now + 31 * 60_000), false);
  // Re-applying after expiry prunes old entries.
  active = applyAlert(active, null, 30, now + 31 * 60_000);
  assert.deepEqual(active, {});
  assert.equal(providerHasSpike(active, 'claude', now), false);
});

test('alert description names provider, window, change, and time range', () => {
  const from = new Date(2026, 8, 21, 14, 25).getTime();
  const to = new Date(2026, 8, 21, 14, 30).getTime();
  const text = describeAlert({ providerId: 'claude', windowId: 'session', kind: 'absolute', deltaPoints: 11, fromT: from, toT: to });
  assert.equal(text, 'Claude 5h increased 11% between 14:25 and 14:30');
});
