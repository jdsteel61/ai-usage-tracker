'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getZaiPeakState } = require('../src/main/peak');
const { shapeSnapshot } = require('../src/main/snapshotView');
const { buildUsageSummary } = require('../src/renderer/summary');

// Beijing wall-clock helper: epoch ms for Beijing Y-M-D H:M.
const bj = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0) - 8 * 3600_000;

test('peak: inside the Mon-Fri 14:00-18:00 Beijing window', () => {
  const st = getZaiPeakState(bj(2026, 9, 22, 14, 0)); // Tuesday 14:00
  assert.equal(st.mode, 'peak');
  assert.equal(st.endsAt, new Date(bj(2026, 9, 22, 18, 0)).toISOString());
  const late = getZaiPeakState(bj(2026, 9, 22, 17, 59));
  assert.equal(late.mode, 'peak');
});

test('peak: boundaries are exclusive at 18:00 and before 14:00', () => {
  assert.equal(getZaiPeakState(bj(2026, 9, 22, 18, 0)).mode, 'off-peak');
  assert.equal(getZaiPeakState(bj(2026, 9, 22, 13, 59)).mode, 'off-peak');
});

test('peak: weekends are always off-peak', () => {
  // 2026-09-26 is a Saturday, 15:00 Beijing (inside the weekday hours).
  assert.equal(getZaiPeakState(bj(2026, 9, 26, 15, 0)).mode, 'off-peak');
  assert.equal(getZaiPeakState(bj(2026, 9, 27, 15, 0)).mode, 'off-peak'); // Sunday
});

test('peak: nextStartAt points at the next weekday 14:00 Beijing', () => {
  // Friday 19:00 Beijing -> next window is Monday 14:00.
  const st = getZaiPeakState(bj(2026, 9, 25, 19, 0));
  assert.equal(st.mode, 'off-peak');
  assert.equal(st.nextStartAt, new Date(bj(2026, 9, 28, 14, 0)).toISOString());
  // Tuesday 10:00 -> same day 14:00.
  const same = getZaiPeakState(bj(2026, 9, 22, 10, 0));
  assert.equal(same.nextStartAt, new Date(bj(2026, 9, 22, 14, 0)).toISOString());
});

test('peak: timezone-independent (same UTC instant, same state)', () => {
  const t = bj(2026, 9, 22, 15, 0); // Tue 07:00 UTC
  assert.equal(getZaiPeakState(t).mode, 'peak'); // machine tz irrelevant: pure epoch math
});

test('snapshotView: zai carries peak, others do not', () => {
  const view = shapeSnapshot({}, { settings: { providers: { zai: true } }, now: bj(2026, 9, 22, 15, 0) });
  const zai = view.providers.find((p) => p.id === 'zai');
  const codex = view.providers.find((p) => p.id === 'codex');
  assert.equal(zai.peak.mode, 'peak');
  assert.equal(codex.peak, null);
});

test('summary: peak/off-peak suffix included for agents', () => {
  const snap = { now: 0, providers: [
    { id: 'zai', title: 'Z.ai', enabled: true, ok: true, plan: 'max', stale: false,
      peak: { mode: 'off-peak', description: 'x' },
      windows: { session: { label: '5 hr', usedPercent: 22, resetsAt: '2026-09-22T12:40:00Z' }, weekly: { label: 'Week', usedPercent: 55, resetsAt: '2026-09-25T15:00:00Z' } }, notes: [] },
    { id: 'claude', title: 'Claude', enabled: true, ok: true, plan: null, stale: false, peak: null,
      windows: { session: { label: '5 hr', usedPercent: 2, resetsAt: '2026-09-22T14:00:00Z' }, weekly: { label: 'Week', usedPercent: 84, resetsAt: '2026-09-24T15:00:00Z' } }, notes: [] },
  ] };
  const text = buildUsageSummary(snap, { now: Date.parse('2026-09-22T09:00:00Z') });
  assert.ok(text.includes('[off-peak: 50% credit]'));
  const lines = text.split('\n');
  assert.ok(!lines.find((l) => l.startsWith('Claude')).includes('peak'));
});
