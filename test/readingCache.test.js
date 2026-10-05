'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeReading, loadReadings, saveReadings } = require('../src/main/readingCache');

function cacheFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aitracker-readings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'readings.json');
}

function snapshot(extra = {}) {
  return {
    providerId: 'codex', ok: true, plan: 'pro', fetchedAt: 1234,
    windows: [{ id: 'codex:session', kind: 'session', label: '5 hr', usedPercent: 31,
      resetsAt: '2026-10-02T10:00:00.000Z', periodSeconds: 18000 }],
    notes: [], ...extra,
  };
}

test('reading cache: roundtrip every provider and profile, always loaded as stale', (t) => {
  const filePath = cacheFile(t);
  const ids = ['codex', 'claude', 'zai', 'grok', 'gemini', 'openrouter',
    'codex-profile-work', 'claude-profile-work'];
  const readings = Object.fromEntries(ids.map((id) => [id, snapshot({ providerId: id })]));
  readings.claude.notes = ['From Claude Code status line'];
  saveReadings(filePath, readings, ids);
  const loaded = loadReadings(filePath, ids);
  assert.deepEqual(Object.keys(loaded), ids);
  for (const id of ids) {
    assert.equal(loaded[id].providerId, id);
    assert.equal(loaded[id].stale, true);
    assert.equal(loaded[id].fetchedAt, 1234);
    assert.equal(loaded[id].windows[0].usedPercent, 31);
  }
  assert.equal(loaded.claude.source, 'claude-statusline');
  assert.deepEqual(loaded.claude.notes, ['From Claude Code status line']);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['readings.json'], 'temporary file renamed');
});

test('reading cache: Claude API readings keep their source note', (t) => {
  const filePath = cacheFile(t);
  saveReadings(filePath, { claude: snapshot({ providerId: 'claude', source: 'claude-api', notes: ['From Claude usage API'] }) }, ['claude']);
  const loaded = loadReadings(filePath, ['claude']);
  assert.equal(loaded.claude.source, 'claude-api');
  assert.deepEqual(loaded.claude.notes, ['From Claude usage API']);
});

test('reading cache: serializes only normalized fields, drops secrets, raw responses and errors', (t) => {
  const filePath = cacheFile(t);
  const snap = snapshot({ accessToken: 'SECRET_TOKEN', raw: { secret: 'SECRET_RAW' },
    lastError: { message: 'SECRET_ERROR' }, notes: ['SECRET_NOTE', 'From Claude Code status line'],
    windows: [{ kind: 'other', id: 'zai:webSearches', label: 'Web searches', usedPercent: 20,
      usedValue: 2, limitValue: 10, raw: { credential: 'SECRET_WINDOW' },
      token: 'SECRET_TOKEN', resetsAt: null, periodSeconds: 300 }],
  });
  saveReadings(filePath, { zai: snap, unknown: snapshot({ plan: 'SECRET_UNKNOWN' }) }, ['zai']);
  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.ok(!persisted.includes('SECRET'));
  assert.ok(!persisted.includes('raw'));
  assert.ok(!persisted.includes('lastError'));
  const window = loadReadings(filePath, ['zai']).zai.windows[0];
  assert.equal(window.kind, 'other');
  assert.equal(window.usedValue, 2);
  assert.equal(window.limitValue, 10);
});

test('reading cache: failed and malformed readings are excluded, unknown percentages survive', (t) => {
  const filePath = cacheFile(t);
  const readings = {
    codex: snapshot({ windows: [{ kind: 'weekly', usedPercent: null, resetsAt: null }] }),
    claude: snapshot({ ok: false }),
    zai: snapshot({ fetchedAt: '1234' }),
    grok: snapshot({ fetchedAt: NaN }),
  };
  saveReadings(filePath, readings, Object.keys(readings));
  const loaded = loadReadings(filePath, Object.keys(readings));
  assert.deepEqual(Object.keys(loaded), ['codex']);
  assert.equal(loaded.codex.windows[0].usedPercent, null);
  const safe = safeReading('codex', snapshot({ windows: [
    { kind: 'session', usedPercent: Infinity },
    { kind: 'weekly', usedPercent: -1 },
    { kind: 'other', usedPercent: 101 },
    { kind: 'unknown', usedPercent: 20 },
  ] }));
  assert.deepEqual(safe.windows, []);
});

test('reading cache: corrupt/missing caches are empty and legacy Claude maps are accepted', (t) => {
  const filePath = cacheFile(t);
  assert.deepEqual(loadReadings(filePath, ['claude']), {});
  for (const data of ['invalid json', 'null', '[]', '42']) {
    fs.writeFileSync(filePath, data);
    assert.deepEqual(loadReadings(filePath, ['claude']), {});
  }
  const legacy = { claude: snapshot({ windows: [{ kind: 'weekly', label: 'Week', usedPercent: 34 }] }) };
  fs.writeFileSync(filePath, JSON.stringify(legacy));
  const original = fs.readFileSync(filePath, 'utf8');
  assert.equal(loadReadings(filePath, ['claude']).claude.windows[0].usedPercent, 34);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original, 'loading leaves legacy data untouched');
});

test('reading cache: disabled readings survive unrelated fresh results and restart', (t) => {
  const filePath = cacheFile(t);
  const allowed = ['codex', 'zai'];
  saveReadings(filePath, { codex: snapshot({ fetchedAt: 1000 }) }, allowed);
  const merged = { ...loadReadings(filePath, allowed), zai: snapshot({ fetchedAt: 2000 }) };
  saveReadings(filePath, merged, allowed);
  const loaded = loadReadings(filePath, allowed);
  assert.equal(loaded.codex.fetchedAt, 1000, 'disabled Codex retains its original reading');
  assert.equal(loaded.zai.fetchedAt, 2000);
});

test('reading cache: per-window observation times survive a save and load', (t) => {
  const file = cacheFile(t);
  const claude = snapshot({ providerId: 'claude', source: 'claude-statusline', notes: ['From Claude Code status line'],
    windows: [{ ...snapshot().windows[0], observedAt: 1200 }] });
  saveReadings(file, { claude }, ['claude']);
  assert.equal(loadReadings(file, ['claude']).claude.windows[0].observedAt, 1200);
  assert.equal(safeReading('claude', { ...claude, windows: [{ ...claude.windows[0], observedAt: 'soon' }] })
    .windows[0].observedAt, undefined);
});

test('reading cache: a pre-planted fixed temporary name is never written through', (t) => {
  const file = cacheFile(t);
  fs.writeFileSync(`${file}.tmp`, 'victim');
  saveReadings(file, { codex: snapshot() }, ['codex']);
  assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), 'victim');
});
