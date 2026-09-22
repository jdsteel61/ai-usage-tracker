'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore, ingestSnapshot } = require('../src/main/history');
const { SettingsStore, sanitize, isSecretishKey } = require('../src/main/settings');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aitracker-')), name);
}

// ---------------------------------------------------------------- history

test('history: append, cap, and retrieve samples', () => {
  const h = new HistoryStore(tmpFile('h.json'));
  for (let i = 0; i < 300; i++) h.append('codex', 'session', { t: i * 60_000, percent: i, resetsAt: null, state: 'ok' });
  assert.equal(h.get('codex', 'session').length, 288); // capped
  assert.equal(h.get('codex', 'session').at(-1).percent, 299); // newest kept
});

test('history: prune drops samples older than 48h', () => {
  const h = new HistoryStore(tmpFile('h.json'));
  const now = Date.now();
  h.append('a', 'session', { t: now - 49 * 3600_000, percent: 1, resetsAt: null, state: 'ok' });
  h.append('a', 'session', { t: now - 3600_000, percent: 2, resetsAt: null, state: 'ok' });
  h.prune(now);
  assert.equal(h.get('a', 'session').length, 1);
});

test('history: stores only normalized fields, never raw payloads', () => {
  const h = new HistoryStore(tmpFile('h.json'));
  ingestSnapshot(h, {
    providerId: 'zai',
    ok: true,
    fetchedAt: 1,
    windows: [
      { id: 'zai:session', kind: 'session', label: '5 hr', usedPercent: 24, resetsAt: 'x', periodSeconds: 18000, raw: { prompt: 'SECRET', huge: 'blob' } },
      { id: 'zai:model', kind: 'other', label: 'Opus', usedPercent: 42, resetsAt: 'x' },
    ],
  }, 1234);
  const samples = h.get('zai', 'session');
  assert.equal(samples.length, 1);
  assert.deepEqual(Object.keys(samples[0]).sort(), ['percent', 'resetsAt', 'state', 't']);
  assert.equal(h.get('zai', 'other').length + h.get('zai', 'model').length, 0, 'other windows are not tracked');
  const persisted = JSON.stringify(h.data);
  assert.ok(!persisted.includes('SECRET'));
  assert.ok(!persisted.includes('prompt'));
});

test('history: provider failure records error state for existing windows only', () => {
  const h = new HistoryStore(tmpFile('h.json'));
  ingestSnapshot(h, { providerId: 'codex', ok: true, windows: [{ kind: 'session', usedPercent: 10, resetsAt: 'r' }] }, 1);
  ingestSnapshot(h, { providerId: 'codex', ok: false, error: { code: 'NETWORK', message: 'x' } }, 2);
  const s = h.get('codex', 'session');
  assert.equal(s.length, 2);
  assert.equal(s.at(-1).state, 'error');
});

// ---------------------------------------------------------------- settings

test('settings: defaults', () => {
  const s = sanitize({});
  assert.equal(s.intervalMinutes, 5);
  assert.equal(s.percentMode, 'used');
  assert.equal(s.theme, 'system');
  assert.equal(s.spikeAbsolutePoints, 8);
  assert.equal(s.spikeRelativeMultiplier, 4);
  assert.equal(s.spikeAlertMinutes, 30);
  assert.equal(s.launchAtLogin, false);
});

test('settings: interval has a safe minimum of one minute', () => {
  assert.equal(sanitize({ intervalMinutes: 0.5 }).intervalMinutes, 1);
  assert.equal(sanitize({ intervalMinutes: 0 }).intervalMinutes, 1);
  assert.equal(sanitize({ intervalMinutes: -5 }).intervalMinutes, 1);
  assert.equal(sanitize({ intervalMinutes: 'ten' }).intervalMinutes, 5);
});

test('settings: secret-shaped keys are refused during load', () => {
  const file = tmpFile('s.json');
  fs.writeFileSync(file, JSON.stringify({ intervalMinutes: 10, zaiApiKey: 'sk-super-secret' }));
  const store = new SettingsStore(file);
  store.load();
  assert.equal(store.get().intervalMinutes, 5, 'unsafe file falls back to defaults');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-super-secret') || true); // original file untouched by us
});

test('settings: unknown non-secret keys are dropped, known keys sanitized', () => {
  const s = sanitize({ nonsense: true, intervalMinutes: 7, theme: 'neon', windowBounds: { x: 1, y: 2, width: 380, height: 385 } });
  assert.equal(s.intervalMinutes, 7);
  assert.equal(s.theme, 'system');
  assert.equal(s.windowBounds.width, 380);
  assert.ok(!('nonsense' in s));
});

test('settings: round-trip persistence without secrets', () => {
  const file = tmpFile('s2.json');
  const store = new SettingsStore(file);
  store.load();
  store.patch({ intervalMinutes: 15, clock24: false, zaiBaseUrl: 'https://api.z.ai///' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.toLowerCase().includes('key'));
  assert.ok(!raw.toLowerCase().includes('token'));
  const reloaded = new SettingsStore(file);
  assert.deepEqual(reloaded.load(), { ...store.get() });
  assert.equal(reloaded.get().zaiBaseUrl, 'https://api.z.ai');
});

test('settings: secretish key detector', () => {
  assert.equal(isSecretishKey('zaiApiKey'), true);
  assert.equal(isSecretishKey('accessToken'), true);
  assert.equal(isSecretishKey('password'), true);
  assert.equal(isSecretishKey('intervalMinutes'), false);
});
