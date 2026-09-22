'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shapeSnapshot, shapeProvider } = require('../src/main/snapshotView');
const { DEFAULTS } = require('../src/main/settings');

/**
 * Regression tests for the settings-panel freeze: `broadcast` used to throw
 * TypeError on providers with ok:false (they carry NO windows array), which
 * rejected the settings:patch IPC and left the Done button a no-op. The
 * shaping must tolerate EVERY provider state without throwing.
 */

const NOW = 1_790_000_000_000;

function okSnap(id, pct = 10) {
  return {
    providerId: id, ok: true, plan: 'pro', notes: [], fetchedAt: NOW - 30_000,
    windows: [
      { id: `${id}:session`, kind: 'session', label: '5 hr', usedPercent: pct, resetsAt: 'x', periodSeconds: 18000 },
      { id: `${id}:weekly`, kind: 'weekly', label: 'Week', usedPercent: pct / 2, resetsAt: 'y', periodSeconds: 604800 },
    ],
  };
}

test('shapeSnapshot: failing provider without windows array does not throw', () => {
  const merged = {
    codex: { providerId: 'codex', ok: false, error: { code: 'NO_CLI', message: 'not found' }, fetchedAt: NOW },
    claude: okSnap('claude'),
    zai: { providerId: 'zai', ok: false, error: { code: 'NO_KEY', message: 'no key' }, fetchedAt: NOW },
  };
  const view = shapeSnapshot(merged, { settings: { ...DEFAULTS }, activeAlerts: {}, now: NOW });
  assert.equal(view.providers.length, 6);
  const codex = view.providers.find((p) => p.id === 'codex');
  assert.equal(codex.ok, false);
  assert.deepEqual(codex.windows, { session: null, weekly: null });
  assert.equal(codex.error.code, 'NO_CLI');
  const claude = view.providers.find((p) => p.id === 'claude');
  assert.equal(claude.ok, true);
  assert.equal(claude.windows.session.usedPercent, 10);
  assert.equal(claude.windows.weekly.usedPercent, 5);
});

test('shapeSnapshot: undefined (disabled) providers get DISABLED view', () => {
  const view = shapeSnapshot({ claude: okSnap('claude') }, { settings: { ...DEFAULTS }, activeAlerts: {}, now: NOW });
  const codex = view.providers.find((p) => p.id === 'codex');
  assert.equal(codex.ok, false);
  assert.equal(codex.error.code, 'DISABLED');
  assert.deepEqual(codex.windows, { session: null, weekly: null });
});

test('shapeSnapshot: stale cached snapshot keeps windows and gains age label', () => {
  const merged = {
    claude: { ...okSnap('claude'), stale: true, fetchedAt: NOW - 12 * 60_000, lastError: { code: 'NETWORK', message: 'x' } },
  };
  const view = shapeSnapshot(merged, { settings: { ...DEFAULTS }, activeAlerts: {}, now: NOW });
  const claude = view.providers.find((p) => p.id === 'claude');
  assert.equal(claude.ok, true);
  assert.equal(claude.stale, true);
  assert.equal(claude.staleAgeLabel, '12m old');
  assert.ok(claude.windows.session, 'cached windows preserved');
});

test('shapeSnapshot: snapshot missing notes/windows fields entirely is tolerated', () => {
  const merged = { claude: { providerId: 'claude', ok: true, fetchedAt: NOW } };
  const view = shapeSnapshot(merged, { settings: { ...DEFAULTS }, activeAlerts: {}, now: NOW });
  const claude = view.providers.find((p) => p.id === 'claude');
  assert.equal(claude.ok, true);
  assert.deepEqual(claude.windows, { session: null, weekly: null });
});

test('shapeSnapshot: active alert produces spike description on the provider', () => {
  const alert = { providerId: 'claude', windowId: 'session', kind: 'absolute', deltaPoints: 11, fromT: NOW - 300_000, toT: NOW };
  const activeAlerts = { 'claude:session': { alert, until: NOW + 60_000 } };
  const view = shapeSnapshot({ claude: okSnap('claude') }, { settings: { ...DEFAULTS }, activeAlerts, now: NOW });
  const claude = view.providers.find((p) => p.id === 'claude');
  assert.ok(claude.spike);
  assert.match(claude.spike.description, /Claude 5h increased 11%/);
  const codex = view.providers.find((p) => p.id === 'codex');
  assert.equal(codex.spike, null);
});

test('shapeSnapshot: empty merged map never throws (fresh boot, settings patch)', () => {
  const view = shapeSnapshot({}, { settings: { ...DEFAULTS }, activeAlerts: {}, now: NOW });
  assert.equal(view.providers.length, 6);
  assert.ok(view.providers.every((p) => p.ok === false));
});

test('shapeProvider: malformed windows entries are skipped', () => {
  const snap = { providerId: 'zai', ok: true, fetchedAt: NOW, windows: [null, 'junk', { kind: 'session', label: '5 hr', usedPercent: 5 }, { kind: 'weekly' }] };
  const view = shapeProvider('zai', snap, { enabled: true, activeAlerts: {}, now: NOW });
  assert.equal(view.windows.session.usedPercent, 5);
  assert.ok(view.windows.weekly, 'entry found by kind');
  assert.ok(!Number.isFinite(view.windows.weekly.usedPercent), 'missing fields stay non-finite (renderer renders dash)');
});
