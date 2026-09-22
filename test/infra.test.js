'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redact, Logger } = require('../src/main/logger');
const { clampToBounds, defaultPosition, DEFAULT_WIDTH, DEFAULT_HEIGHT, LEGACY_DEFAULTS } = require('../src/main/windowState');
const { Scheduler, DEBOUNCE_MS } = require('../src/main/scheduler');

// ---------------------------------------------------------------- redaction

test('redaction: bearer and basic tokens', () => {
  assert.equal(redact('Authorization: Bearer abc123def456ghi789'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact('Basic dXNlcjpwYXNzd29yZA=='), 'Basic [REDACTED]');
});

test('redaction: API keys', () => {
  assert.equal(redact('key sk-proj-abcdefghijklmnop123456 rejected'), 'key [REDACTED] rejected');
  assert.equal(redact('zai key 0123456789abcdef0123456789abcdef.j8Hx_k2'), 'zai key [REDACTED]');
});

test('redaction: credential JSON fields', () => {
  const redacted = redact('{"accessToken":"eyJhbGciOiJIUzI1NiJ9.payload","refresh_token":"rt_918273645"}');
  assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9.payload'));
  assert.ok(!redacted.includes('rt_918273645'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redaction: long blobs', () => {
  const blob = 'A'.repeat(64);
  assert.ok(!redact(`leak ${blob}`).includes(blob));
});

test('redaction: home directory paths', () => {
  const out = redact(`reading C:\\Users\\someuser\\.claude\\.credentials.json failed`);
  assert.ok(!out.includes('someuser'));
});

test('redaction: logger output is redacted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), 'main.log');
  const logger = new Logger(file);
  logger.open();
  const secret = 'Bearer super-secret-token-value-123';
  logger.info('test', `failed request with ${secret}`);
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(!written.includes(secret));
  assert.ok(written.includes('[REDACTED]'));
});

// ---------------------------------------------------------------- window state

test('window state: defaults when nothing saved', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = clampToBounds(null, wa);
  assert.equal(b.width, DEFAULT_WIDTH);
  assert.equal(b.height, DEFAULT_HEIGHT);
  assert.equal(b.x, 1920 - DEFAULT_WIDTH - 24);
  assert.equal(b.y, 24);
});

test('window state: legacy default sizes migrate to the compact default', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  for (const legacy of LEGACY_DEFAULTS) {
    const b = clampToBounds({ x: 100, y: 100, ...legacy }, wa);
    assert.deepEqual(b, defaultPosition(wa));
  }
  // A user-chosen non-legacy size is still honored.
  const kept = clampToBounds({ x: 100, y: 100, width: 420, height: 300 }, wa);
  assert.deepEqual(kept, { x: 100, y: 100, width: 420, height: 300 });
});

test('window state: saved bounds are honored and clamped to the work area', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const ok = clampToBounds({ x: 100, y: 100, width: 400, height: 500 }, wa);
  assert.deepEqual(ok, { x: 100, y: 100, width: 400, height: 500 });
  // Off-screen right: nudged back inside.
  const nudged = clampToBounds({ x: 1900, y: 100, width: 400, height: 500 }, wa);
  assert.equal(nudged.x, 1920 - 400);
  // Completely off-screen: falls back to default position.
  const gone = clampToBounds({ x: -5000, y: -5000, width: 400, height: 500 }, wa);
  assert.deepEqual(gone, defaultPosition(wa));
});

test('window state: undersized bounds respect minimums', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = clampToBounds({ x: 10, y: 10, width: 50, height: 50 }, wa);
  assert.equal(b.width, 250);
  assert.equal(b.height, 170);
});

// ---------------------------------------------------------------- scheduler

test('scheduler: manual refresh is debounced', async () => {
  let runs = 0;
  const s = new Scheduler(async () => { runs++; }, {
    setIntervalMs: () => 0,
    random: () => 0.5,
  });
  assert.equal(s.refreshNow(), true); // first: runs
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs, 1);
  assert.equal(s.refreshNow(), false); // within debounce window: suppressed
  assert.equal(s.refreshNow(), false);
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 20));
  assert.equal(s.refreshNow(), true); // after debounce: runs again
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs, 2);
});

test('scheduler: loop ticks at jittered cadence and stop cancels', async () => {
  const ticked = [];
  let handle = null;
  const s = new Scheduler(async () => { ticked.push(Date.now()); }, {
    setIntervalMs: (fn, ms) => { handle = setInterval(fn, ms); return handle; },
    random: () => 0.5,
  });
  s.start(1); // 60s interval, jitter -> no extra ticks during the test
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(ticked.length >= 1, 'immediate first run');
  s.stop();
  const count = ticked.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ticked.length, count, 'no ticks after stop');
  clearInterval(handle);
});

test('scheduler: manual refresh queued mid-flight runs after completion', async () => {
  let runs = 0;
  const s = new Scheduler(async () => { runs++; await new Promise((r) => setTimeout(r, 80)); }, {
    setIntervalMs: () => 0,
    random: () => 0.5,
  });
  s.runOnce(s.generation); // starts an in-flight run
  await new Promise((r) => setTimeout(r, 10));
  s.lastManualAt = 0; // bypass debounce for the test
  assert.equal(s.refreshNow(), false); // queued, not started
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(runs, 2, 'queued manual refresh coalesced into one follow-up run');
});

 test('scheduler: re-entrant runs are skipped', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const s = new Scheduler(async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 60));
    concurrent--;
  }, { setIntervalMs: () => 0, random: () => 0.5 });
  s.runOnce(s.generation);
  s.runOnce(s.generation);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(maxConcurrent, 1);
});
