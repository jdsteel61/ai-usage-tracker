'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ClaudeApiBudget, parseRetryAfter, MIN_INTERVAL_MS, STAGGER_MS, BACKOFF_MS, MAX_RETRY_AFTER_MS,
  SUCCESSES_TO_EASE, QUIET_EASE_MS, UNRECOVERABLE_BLOCK_MS,
} = require('../src/main/claudeApiBudget');
const { fetchClaudeQuotas, normalizeClaudeApiUsage, readClaudeAuth, API_TOPUP_AFTER_MS } = require('../src/main/providers/claude');
const { mergeClaudeReadings, reconcileClaudeReadings, orderByObservationAge, API_STALE_MS } = require('../src/main/claudeMerge');
const { writeFileAtomic } = require('../src/main/atomicWrite');

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-05T10:00:00Z');

/** Wall clock and monotonic clock. advance() moves both; jumpWall() is a clock change. */
function clock(start = T0) {
  const c = { t: start, m: 1_000_000, now: () => c.t, mono: () => c.m };
  c.advance = (ms) => { c.t += ms; c.m += ms; };
  c.jumpWall = (ms) => { c.t += ms; };
  return c;
}

function budgetFor(c, file = null, extra = {}) {
  return new ClaudeApiBudget(file, { now: c.now, mono: c.mono, random: () => 0, ...extra });
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')); }

// ------------------------------------------------------------ budget

test('budget: min interval per profile and one call started per minute globally', () => {
  const c = clock();
  const b = budgetFor(c);
  assert.equal(b.check('a').ok, true);
  assert.equal(b.begin('a'), true);
  assert.equal(b.check('a').reason, 'interval');
  assert.equal(b.check('b').reason, 'stagger');
  c.advance(STAGGER_MS);
  assert.equal(b.check('a').reason, 'interval');
  assert.equal(b.check('b').ok, true, 'another profile only waits for the stagger');
  b.begin('b');
  assert.equal(b.check('c').reason, 'stagger');
  c.advance(MIN_INTERVAL_MS - STAGGER_MS);
  assert.equal(b.check('a').ok, true);
});

test('budget: 429 waits the longest of cooldown, escalation step and a valid Retry-After', () => {
  const c = clock();
  const b = budgetFor(c);
  assert.equal(b.rateLimited('a', 30 * MIN), c.t + HOUR, 'a short Retry-After does not beat the first step');
  assert.equal(b.check('a').reason, 'cooldown');
  assert.equal(b.rateLimited('a', 0), c.t + 2 * HOUR, 'retry-after 0 is ignored; second step');
  assert.equal(b.rateLimited('a', null), c.t + 4 * HOUR);
  assert.equal(b.rateLimited('a', 1000), c.t + 4 * HOUR, 'tiny Retry-After cannot shorten an established ban');
  c.advance(HOUR);
  assert.equal(b.rateLimited('a', 1), c.t + 4 * HOUR, 'the next ban is at least the escalation step, not what is left');
});

test('budget: reproduction - Retry-After: 1 after escalation to four hours stays at four hours', () => {
  const c = clock();
  const b = budgetFor(c);
  for (let i = 0; i < 3; i++) { b.rateLimited('a'); c.advance(5 * HOUR); }
  const retryAt = b.rateLimited('a', 1000);
  assert.equal(retryAt - c.t, BACKOFF_MS[2]);
  assert.equal(b.check('a').reason, 'cooldown');
});

test('budget: long valid Retry-After is honoured up to 24h; absurd values are capped', () => {
  const c = clock();
  const b = budgetFor(c);
  assert.equal(b.rateLimited('a', 12 * HOUR), c.t + 12 * HOUR, 'twelve hours on the first failure');
  assert.equal(b.rateLimited('b', 99 * HOUR), c.t + MAX_RETRY_AFTER_MS, 'capped at 24h');
});

test('budget: a remaining cooldown longer than the next step is never shortened', () => {
  const c = clock();
  const b = budgetFor(c);
  b.rateLimited('a', 20 * HOUR);
  c.advance(HOUR);
  assert.equal(b.rateLimited('a', null) - c.t, 19 * HOUR);
});

test('budget: 429 waits get a small positive jitter', () => {
  const c = clock();
  const b = budgetFor(c, null, { random: () => 0.5 });
  const wait = b.rateLimited('a') - c.t;
  assert.ok(wait > HOUR && wait <= HOUR * 1.1, `jittered wait ${wait}`);
});

test('budget: one success does not reset escalation; several successes or a long quiet spell ease it', () => {
  const c = clock();
  const b = budgetFor(c);
  for (let i = 0; i < 3; i++) { b.rateLimited('a'); c.advance(5 * HOUR); }
  b.success('a');
  assert.equal(b.rateLimited('a') - c.t, 4 * HOUR, 'alternating success/429 does not return to 1h');
  c.advance(5 * HOUR);
  for (let i = 0; i < SUCCESSES_TO_EASE; i++) b.success('a');
  assert.equal(b.rateLimited('a') - c.t, 4 * HOUR, 'level 2 is still the 4h step');
  c.advance(5 * HOUR + 3 * QUIET_EASE_MS); // a long quiet spell
  assert.equal(b.rateLimited('a') - c.t, HOUR, 'sustained quiet decays the ladder');
});

test('budget: 401/403 blocks until credentials or local capture change', () => {
  const c = clock();
  const b = budgetFor(c);
  b.authFailed('a', { credMtimeMs: 100, localAt: 5 });
  c.advance(10 * HOUR);
  assert.equal(b.check('a', { credMtimeMs: 100, localAt: 5 }).reason, 'auth');
  assert.equal(b.check('a', { credMtimeMs: 100, localAt: 5 }).reason, 'auth', 'no hammering over time');
  assert.equal(b.check('a', { credMtimeMs: 101, localAt: 5 }).ok, true, 'new credentials unblock');
  b.authFailed('a', { credMtimeMs: 101, localAt: 5 });
  assert.equal(b.check('a', { credMtimeMs: 101, localAt: 6 }).ok, true, 'newer local capture unblocks');
});

test('budget: cooldown state persists across restarts as timestamps and counters only', () => {
  const dir = tempDir();
  const file = path.join(dir, 'claude-api-budget.json');
  try {
    const c = clock();
    const first = budgetFor(c, file);
    first.begin('a');
    first.rateLimited('a', null);
    first.authFailed('b', { credMtimeMs: 7, localAt: 3 });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['blockUntilAt', 'lastStartAt', 'profiles', 'version']);
    c.advance(5 * MIN);
    const second = budgetFor(c, file);
    assert.equal(second.check('a').reason, 'cooldown');
    assert.equal(second.check('b', { credMtimeMs: 7, localAt: 3 }).reason, 'auth');
    assert.equal(second.status('a').retryAt, first.status('a').retryAt);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: reproduction - an unexpired cooldown beyond the 64th entry survives restart; expired entries are pruned first', () => {
  const dir = tempDir();
  const file = path.join(dir, 'claude-api-budget.json');
  try {
    const c = clock();
    const first = budgetFor(c, file);
    for (let i = 0; i < 70; i++) first.rateLimited(`old-${i}`, null);
    c.advance(5 * HOUR); // all of those expire
    for (let i = 0; i < 70; i++) first.rateLimited(`live-${i}`, 12 * HOUR);
    first.authFailed('blocked', { credMtimeMs: 1, localAt: 0 });
    const second = budgetFor(c, file);
    for (let i = 0; i < 70; i++) assert.equal(second.check(`live-${i}`).reason, 'cooldown', `live-${i}`);
    assert.equal(second.check('blocked', { credMtimeMs: 1, localAt: 0 }).reason, 'auth');
    assert.equal(Object.keys(second.profiles).filter((id) => id.startsWith('old-')).length, 0, 'expired entries pruned');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: reproduction - advancing the wall clock does not end a cooldown; moving it back does not extend one', () => {
  const c = clock();
  const b = budgetFor(c);
  b.rateLimited('a', null);
  c.jumpWall(2 * HOUR);
  assert.equal(b.check('a').reason, 'cooldown', 'forward clock change cannot bypass the ban');
  c.jumpWall(-6 * HOUR);
  c.advance(HOUR);
  assert.equal(b.check('a').ok, true, 'real elapsed time (1h+) ended it despite the backward jump');
  const c2 = clock();
  const d = budgetFor(c2);
  d.begin('x');
  c2.jumpWall(10 * HOUR);
  assert.equal(d.check('x').reason, 'interval', 'a forward clock change does not end the minimum interval either');
});

test('budget: persisted deadlines are reconciled conservatively on load', () => {
  const dir = tempDir();
  const file = path.join(dir, 'claude-api-budget.json');
  try {
    const c = clock();
    fs.writeFileSync(file, JSON.stringify({ version: 1, lastStartAt: c.t + 5 * HOUR, profiles: {
      far: { lastCallAt: c.t + 9 * HOUR, retryAt: c.t + 400 * HOUR, failures: 3 },
      back: { lastCallAt: c.t + 3 * HOUR, retryAt: 0, failures: 0 },
    } }));
    const b = budgetFor(c, file);
    const far = b.check('far');
    assert.equal(far.reason, 'cooldown');
    assert.ok(far.retryAt - c.t <= 30 * HOUR, 'absurd future deadline is clamped');
    assert.equal(b.check('back').reason, 'interval', 'a last-call time in the future counts as just now');
    assert.equal(b.check('fresh').reason, 'stagger', 'so does the last start');
    c.advance(STAGGER_MS);
    assert.equal(b.check('back').reason, 'interval');
    assert.equal(b.check('fresh').ok, true);
    c.advance(MIN_INTERVAL_MS);
    assert.equal(b.check('back').ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** fs wrapper that can fail writes, to model a full or read-only disk. */
function flakyFs() {
  const state = { failWrites: false };
  const wrapped = { ...fs };
  for (const name of ['openSync', 'writeFileSync', 'renameSync', 'mkdirSync']) {
    wrapped[name] = (...args) => {
      if (state.failWrites && name !== 'mkdirSync') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return fs[name](...args);
    };
  }
  return { state, fsImpl: wrapped };
}

test('budget: reproduction - a failed save suspends dispatch instead of allowing it; recovery resumes', () => {
  const dir = tempDir();
  try {
    const c = clock();
    const { state, fsImpl } = flakyFs();
    const b = budgetFor(c, path.join(dir, 'b.json'), { fsImpl });
    assert.equal(b.check('a').ok, true);
    state.failWrites = true;
    assert.equal(b.begin('a'), false, 'no durable reservation, no dispatch');
    c.advance(HOUR);
    assert.equal(b.check('a').reason, 'suspended');
    assert.equal(b.check('other').reason, 'suspended');
    state.failWrites = false;
    assert.equal(b.check('other').ok, true, 'saves work again: top-ups resume');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')).lastStartAt > 0, 'the reservation reached disk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: reproduction - corrupt state no longer means an unrestricted budget', () => {
  const dir = tempDir();
  const file = path.join(dir, 'b.json');
  try {
    const c = clock();
    const first = budgetFor(c, file);
    first.rateLimited('a', 3 * HOUR);
    first.begin('a');
    // main file damaged, backup intact: state is recovered
    fs.writeFileSync(file, '{ not json');
    const recovered = budgetFor(c, file);
    assert.equal(recovered.check('a').reason, 'cooldown', 'bans survive via the backup');
    assert.equal(recovered.check('b').reason, 'stagger', 'calls since the backup are unknown, so wait a stagger');
    // both damaged: suspend rather than guess
    fs.writeFileSync(file, '[]');
    fs.writeFileSync(`${file}.bak`, 'junk');
    const lost = budgetFor(c, file);
    assert.equal(lost.check('a').reason, 'suspended');
    assert.equal(lost.check('z').reason, 'suspended');
    c.advance(UNRECOVERABLE_BLOCK_MS + MIN);
    assert.equal(budgetFor(c, file).check('z').ok, true, 'the block is persisted and then ends');
    // unreadable state (a directory) is not a first run either
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.bak`, { force: true });
    fs.mkdirSync(file);
    assert.equal(budgetFor(c, file).check('z').reason, 'suspended');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: a genuine first run (no file, no backup) is allowed', () => {
  const dir = tempDir();
  try {
    const b = budgetFor(clock(), path.join(dir, 'never-existed.json'));
    assert.equal(b.check('a').ok, true);
    assert.equal(b.begin('a'), true);
    assert.ok(fs.existsSync(path.join(dir, 'never-existed.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: every save keeps the previous state as a backup', () => {
  const dir = tempDir();
  const file = path.join(dir, 'b.json');
  try {
    const c = clock();
    const b = budgetFor(c, file);
    b.begin('a');
    b.rateLimited('a', null);
    const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
    assert.equal(backup.profiles.a.retryAt, 0, 'backup is the state before the last write');
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.a.retryAt > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: purge and retainOnly drop a removed profile', () => {
  const c = clock();
  const b = budgetFor(c);
  b.rateLimited('gone', null);
  b.rateLimited('kept', null);
  b.rateLimited('stale', null);
  b.purge('gone');
  b.retainOnly(['kept']);
  assert.deepEqual(Object.keys(b.profiles), ['kept']);
  assert.equal(b.check('gone').ok, true);
});

test('atomic write: random exclusive temporary file, fsync, rename; a planted temp name is never followed', () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'data.json');
    const planted = `${target}.tmp`;
    fs.writeFileSync(planted, 'victim');
    writeFileAtomic(target, '{"a":1}');
    assert.equal(fs.readFileSync(planted, 'utf8'), 'victim', 'fixed legacy temp name untouched');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['data.json', 'data.json.tmp']);

    const calls = [];
    const spy = { ...fs };
    for (const name of ['openSync', 'fsyncSync', 'renameSync']) {
      spy[name] = (...args) => { calls.push([name, args[1]]); return fs[name](...args); };
    }
    const names = [];
    spy.openSync = (file, flags) => { names.push(file); calls.push(['openSync', flags]); return fs.openSync(file, flags); };
    writeFileAtomic(target, 'x', { fsImpl: spy });
    writeFileAtomic(target, 'y', { fsImpl: spy });
    assert.deepEqual(calls.filter(([n]) => n === 'openSync').map(([, f]) => f), ['wx', 'wx']);
    assert.ok(calls.some(([n]) => n === 'fsyncSync'));
    assert.notEqual(names[0], names[1], 'temporary names are random');
    assert.notEqual(names[0], planted);

    // a temporary name that already exists makes the exclusive open fail instead of overwriting
    const clash = { ...fs, openSync: () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } };
    assert.throws(() => writeFileAtomic(target, 'z', { fsImpl: clash }), /EEXIST/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'y');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget: Retry-After parsing handles seconds, dates and junk', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(new Date(T0 + 5000).toUTCString(), T0), 5000);
});

// ------------------------------------------------------------ provider

const apiBody = {
  five_hour: { utilization: 41.5, resets_at: new Date(T0 + 2 * HOUR).toISOString() },
  seven_day: { utilization: 12, resets_at: new Date(T0 + 3 * 24 * HOUR).toISOString() },
};
const CONFIG_DIR = path.resolve('profile');

function harness({ local = null, status = 200, body = apiBody, headers = {}, previous, apiTopUp = true, token = 'tok-secret', budget, configDir = CONFIG_DIR } = {}) {
  const c = clock();
  const calls = [];
  const writes = [];
  const cred = { mtimeMs: 500, symlink: false };
  const b = budget || budgetFor(c);
  const deps = {
    configDir, profileId: 'claude', apiTopUp, budget: b, previous, now: c.now,
    credentialFs: {
      realpathSync: (p) => p,
      lstatSync: () => ({ isSymbolicLink: () => cred.symlink, isFile: () => true, mtimeMs: cred.mtimeMs }),
    },
    readFileSync: (file) => {
      if (file.endsWith('usage.json')) {
        if (!local) throw new Error('ENOENT');
        return JSON.stringify(local);
      }
      assert.equal(file, path.join(configDir, '.credentials.json'));
      if (token === null) throw new Error('ENOENT');
      return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'must-not-be-used', subscriptionType: 'max' } });
    },
    writeFileSync: (...args) => writes.push(args),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[n] ?? null }, json: async () => body };
    },
  };
  return { c, calls, writes, b, deps, cred };
}

function usageFile(c, { session, weekly }) {
  const windows = {};
  if (session) windows.five_hour = { usedPercent: session[0], observedAt: c.t - session[1], resetsAt: new Date(c.t + HOUR).toISOString() };
  if (weekly) windows.seven_day = { usedPercent: weekly[0], observedAt: c.t - weekly[1], resetsAt: new Date(c.t + 24 * HOUR).toISOString() };
  return { version: 1, windows };
}

function localUsage(c, ageMs, percent = 20) {
  return usageFile(c, { session: [percent, ageMs], weekly: [percent + 1, ageMs] });
}

function withLocal(h, data) {
  h.deps.readFileSync = ((orig) => (f) => (f.endsWith('usage.json') ? JSON.stringify(data) : orig(f)))(h.deps.readFileSync);
}

test('claude api: normalizes utilization windows and flags the source', () => {
  const snap = normalizeClaudeApiUsage(apiBody, { plan: 'max' }, T0);
  assert.equal(snap.source, 'claude-api');
  assert.deepEqual(snap.notes, ['From Claude usage API']);
  assert.equal(snap.fetchedAt, T0);
  assert.equal(snap.plan, 'max');
  assert.deepEqual(snap.windows.map((w) => [w.kind, w.usedPercent, w.observedAt]), [['session', 41.5, T0], ['weekly', 12, T0]]);
  assert.equal(normalizeClaudeApiUsage({}, null, T0).error.code, 'NO_DATA');
});

test('claude api: fresh local capture makes zero API calls', async () => {
  const h = harness();
  withLocal(h, localUsage(h.c, 2 * MIN));
  const snap = await fetchClaudeQuotas(h.deps);
  assert.equal(snap.source, 'claude-statusline');
  assert.equal(h.calls.length, 0);
});

test('claude api: top-up is off by default and never runs without opt-in', async () => {
  const h = harness({ apiTopUp: false });
  const snap = await fetchClaudeQuotas(h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(snap.error.code, 'NO_DATA');
});

test('claude api: missing local reading uses the API read-only with documented headers', async () => {
  const h = harness();
  const snap = await fetchClaudeQuotas(h.deps);
  assert.equal(snap.ok, true);
  assert.equal(snap.source, 'claude-api');
  assert.equal(snap.stale, false);
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, 'Bearer tok-secret');
  assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(h.writes.length, 0, 'credentials are never written');
  assert.doesNotMatch(JSON.stringify(snap), /tok-secret|must-not-be-used/);
});

test('claude api: local capture older than the threshold triggers a top-up; newest observation wins', async () => {
  const h = harness();
  withLocal(h, localUsage(h.c, API_TOPUP_AFTER_MS + MIN));
  const snap = await fetchClaudeQuotas(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(snap.source, 'claude-api');
  assert.equal(snap.windows[0].usedPercent, 41.5);

  // A later local capture beats the earlier API result and costs no call.
  const fresh = harness();
  fresh.deps.previous = snap;
  fresh.c.t = h.c.t + 5 * MIN;
  withLocal(fresh, localUsage(fresh.c, MIN, 55));
  const merged = await fetchClaudeQuotas(fresh.deps);
  assert.equal(fresh.calls.length, 0);
  assert.equal(merged.source, 'claude-statusline');
  assert.equal(merged.windows[0].usedPercent, 55);
});

test('claude api: reproduction - session and weekly each take their newest observation', async () => {
  // local session 80% seen 1 min ago, local weekly seen 40 min ago, API (10% / 30%) seen 5 min ago
  const h = harness();
  const api = normalizeClaudeApiUsage({
    five_hour: { utilization: 10, resets_at: new Date(T0 + 2 * HOUR).toISOString() },
    seven_day: { utilization: 30, resets_at: new Date(T0 + 3 * 24 * HOUR).toISOString() },
  }, null, T0 - 5 * MIN);
  withLocal(h, usageFile(h.c, { session: [80, MIN], weekly: [50, 40 * MIN] }));
  const snap = await fetchClaudeQuotas({ ...h.deps, previous: api });
  assert.equal(h.calls.length, 0, 'session is fresh and weekly is covered by the 5 minute old API reading');
  const byKind = Object.fromEntries(snap.windows.map((w) => [w.kind, w]));
  assert.equal(byKind.session.usedPercent, 80, 'newer local session beats the older API session');
  assert.equal(byKind.weekly.usedPercent, 30, 'newer API weekly beats the older local weekly');
  assert.equal(byKind.session.observedAt, T0 - MIN, 'per-window observation time is preserved');
  assert.equal(byKind.weekly.observedAt, T0 - 5 * MIN);
  assert.equal(snap.fetchedAt, T0 - 5 * MIN, 'overall age is the oldest displayed window');
  assert.equal(snap.stale, false);
});

test('claude api: a recent API reading is kept and not re-fetched when local capture stays old', async () => {
  const h = harness();
  const first = await fetchClaudeQuotas(h.deps);
  h.c.advance(10 * MIN);
  const again = await fetchClaudeQuotas({ ...h.deps, previous: first });
  assert.equal(h.calls.length, 1);
  assert.equal(again.source, 'claude-api');
  assert.equal(again.fetchedAt, first.fetchedAt);
  assert.equal(again.stale, false);
});

test('claude api: 429 keeps the good reading, records a cooldown and stops further calls', async () => {
  const h = harness({ status: 429, headers: { 'retry-after': '0' } });
  const previous = normalizeClaudeApiUsage(apiBody, null, T0 - 40 * MIN);
  const snap = await fetchClaudeQuotas({ ...h.deps, previous });
  assert.equal(snap.ok, true, 'a failed call never blanks a good reading');
  assert.equal(snap.windows[0].usedPercent, 41.5);
  assert.equal(snap.stale, true);
  assert.equal(snap.lastError.code, 'HTTP_429');
  assert.equal(snap.lastError.retryAt, h.c.t + HOUR, 'Retry-After 0 falls back to 1h');
  assert.equal(snap.topUpRetryAt, h.c.t + HOUR, 'the caller can schedule the next try');
  h.c.advance(30 * MIN);
  await fetchClaudeQuotas({ ...h.deps, previous });
  assert.equal(h.calls.length, 1, 'cooldown prevents a second call');
});

test('claude api: reproduction - a reading kept after a failed top-up is stale, not Current (25 to 35 minutes old)', async () => {
  for (const [status, code] of [[429, 'HTTP_429'], [503, 'HTTP_503'], [401, 'NO_AUTH']]) {
    const h = harness({ status });
    const previous = normalizeClaudeApiUsage(apiBody, null, T0 - 26 * MIN);
    const snap = await fetchClaudeQuotas({ ...h.deps, previous });
    assert.equal(snap.ok, true);
    assert.equal(snap.stale, true, `${status}: failed top-up marks the retained reading stale`);
    assert.equal(snap.lastError.code, code);
    // a later poll that is merely waiting for its turn must not flip it back to Current
    h.c.advance(2 * MIN);
    const again = await fetchClaudeQuotas({ ...h.deps, previous: snap });
    assert.equal(again.stale, true, `${status}: stays stale until a newer observation arrives`);
    assert.equal(again.lastError.code, code);
    // a newer successful observation clears it
    withLocal(h, localUsage(h.c, MIN, 33));
    const recovered = await fetchClaudeQuotas({ ...h.deps, previous: again });
    assert.equal(recovered.stale, false);
    assert.equal(recovered.lastError, undefined);
  }
  // a reading that is merely waiting for the stagger is still Current by age
  const queued = harness();
  queued.b.begin('someone-else');
  const waiting = await fetchClaudeQuotas({ ...queued.deps, previous: normalizeClaudeApiUsage(apiBody, null, T0 - 26 * MIN) });
  assert.equal(waiting.stale, false);
  assert.ok(waiting.topUpRetryAt > queued.c.t, 'and a retry is scheduled for when the budget allows');
});

test('claude api: 429 with nothing cached reports the cooldown as the error', async () => {
  const h = harness({ status: 429, headers: { 'retry-after': '7200' } });
  const first = await fetchClaudeQuotas(h.deps);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'HTTP_429');
  assert.equal(first.error.retryAt, h.c.t + 2 * HOUR);
  h.c.advance(MIN);
  const second = await fetchClaudeQuotas(h.deps);
  assert.equal(second.error.code, 'HTTP_429');
  assert.equal(h.calls.length, 1);
});

test('claude api: 401 marks sign-in needed without retrying until credentials change', async () => {
  const h = harness({ status: 401 });
  const first = await fetchClaudeQuotas(h.deps);
  assert.equal(first.error.code, 'NO_AUTH');
  assert.match(first.error.message, /sign-in needed/);
  h.c.advance(5 * HOUR);
  const second = await fetchClaudeQuotas(h.deps);
  assert.equal(second.error.code, 'NO_AUTH');
  assert.equal(h.calls.length, 1);
  h.cred.mtimeMs = 900; // user signed in again
  await fetchClaudeQuotas(h.deps);
  assert.equal(h.calls.length, 2);
  const forbidden = harness({ status: 403 });
  assert.equal((await fetchClaudeQuotas(forbidden.deps)).error.code, 'NO_AUTH');
});

test('claude api: signed-out profile makes no request; other failures keep cached readings', async () => {
  const signedOut = harness({ token: null });
  assert.equal((await fetchClaudeQuotas(signedOut.deps)).error.code, 'NO_AUTH');
  assert.equal(signedOut.calls.length, 0);

  const down = harness({ status: 503 });
  const previous = normalizeClaudeApiUsage(apiBody, null, T0 - 30 * MIN);
  const snap = await fetchClaudeQuotas({ ...down.deps, previous });
  assert.equal(snap.ok, true);
  assert.equal(snap.lastError.code, 'HTTP_503');
});

test('claude api: accounts are staggered so only one starts per minute', async () => {
  const c = clock();
  const budget = budgetFor(c);
  const a = harness({ budget });
  const b = harness({ budget });
  a.deps.now = b.deps.now = c.now;
  b.deps.profileId = 'claude-profile-work';
  const first = await fetchClaudeQuotas(a.deps);
  const second = await fetchClaudeQuotas(b.deps);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'QUEUED');
  assert.equal(second.error.retryAt, c.t + STAGGER_MS, 'the rejection says when to try again');
  assert.equal(b.calls.length, 0);
  c.advance(STAGGER_MS);
  assert.equal((await fetchClaudeQuotas(b.deps)).ok, true);
});

test('claude api: a budget that cannot be saved sends nothing and says top-up is paused', async () => {
  const dir = tempDir();
  try {
    const c = clock();
    const { state, fsImpl } = flakyFs();
    const h = harness({ budget: budgetFor(c, path.join(dir, 'b.json'), { fsImpl }) });
    h.deps.now = c.now;
    state.failWrites = true;
    const snap = await fetchClaudeQuotas(h.deps);
    assert.equal(h.calls.length, 0, 'no durable reservation, no request');
    assert.equal(snap.error.code, 'SUSPENDED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ fairness

async function simulateAccounts({ ordered, retryTimers, hours = 6 }) {
  const c = clock();
  const budget = budgetFor(c);
  const ids = Array.from({ length: 21 }, (_, i) => `claude-profile-${i}`);
  const readings = {};
  const refreshedAt = Object.fromEntries(ids.map((id) => [id, []]));
  let waiting = null; // earliest time the budget said to try again
  const runRound = async () => {
    waiting = null;
    for (const id of ordered ? orderByObservationAge(ids, readings, (x) => budget.lastAttempt(x)) : ids) {
      const h = harness({ budget });
      h.deps.now = c.now;
      h.deps.profileId = id;
      h.deps.fetchImpl = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({
        five_hour: { utilization: 5, resets_at: new Date(c.t + 2 * HOUR).toISOString() },
        seven_day: { utilization: 6, resets_at: new Date(c.t + 72 * HOUR).toISOString() } }) });
      const snap = await fetchClaudeQuotas({ ...h.deps, previous: readings[id] });
      if (snap.ok) readings[id] = snap;
      if (snap.source === 'claude-api' && snap.fetchedAt === c.t) refreshedAt[id].push(c.t);
      const retry = snap.topUpRetryAt || (snap.error && snap.error.retryAt);
      if (retry && (waiting === null || retry < waiting)) waiting = retry;
    }
  };
  let nextPoll = c.t;
  const end = c.t + hours * HOUR;
  while (c.t < end) {
    if (c.t >= nextPoll) { await runRound(); nextPoll += 5 * MIN; } else if (retryTimers && waiting !== null && c.t >= waiting) await runRound();
    c.advance(10_000);
  }
  return { ids, refreshedAt };
}

test('scheduling: with more accounts than one refresh cycle can serve, every idle account is refreshed on time', async () => {
  const { ids, refreshedAt } = await simulateAccounts({ ordered: true, retryTimers: true });
  for (const id of ids) assert.ok(refreshedAt[id].length >= 5, `${id} refreshed ${refreshedAt[id].length} times in 6h`);
  const gaps = ids.map((id) => Math.max(...refreshedAt[id].slice(1).map((t, i) => t - refreshedAt[id][i])));
  assert.ok(Math.max(...gaps) < 60 * MIN, `longest gap ${Math.max(...gaps) / MIN} minutes`);
});

test('scheduling: reproduction - fixed order with 5 minute polls starves later accounts; oldest-first rotation does not', async () => {
  const fixed = await simulateAccounts({ ordered: false, retryTimers: false });
  assert.ok(fixed.ids.some((id) => fixed.refreshedAt[id].length === 0), 'fixed order leaves some accounts unserved');
  const fair = await simulateAccounts({ ordered: true, retryTimers: false });
  for (const id of fair.ids) assert.ok(fair.refreshedAt[id].length >= 2, `${id} refreshed ${fair.refreshedAt[id].length} times without retry timers`);
});

test('scheduling: the account with the oldest observation goes first; ties rotate by last attempt', () => {
  const readings = { a: { ok: true, fetchedAt: 300 }, b: { ok: true, fetchedAt: 100 }, c: { ok: false } };
  assert.deepEqual(orderByObservationAge(['a', 'b', 'c'], readings), ['c', 'b', 'a']);
  assert.deepEqual(orderByObservationAge(['a', 'b', 'c'], {}, (id) => ({ a: 3, b: 1, c: 2 })[id]), ['b', 'c', 'a']);
});

// ------------------------------------------------------------ merging

const win = (kind, percent, observedAt, extra = {}) => ({ kind, usedPercent: percent, observedAt, resetsAt: new Date(T0 + HOUR).toISOString(), ...extra });
const snapOf = (windows, fetchedAt, extra = {}) => ({ ok: true, providerId: 'claude', windows, fetchedAt, stale: false, ...extra });

test('merge: each window takes the newest observation; an unchanged reading keeps its identity', () => {
  const a = snapOf([win('session', 10, 100), win('weekly', 20, 100)], 100);
  const b = snapOf([win('session', 90, 200)], 200);
  const merged = mergeClaudeReadings([a, b]);
  assert.deepEqual(merged.windows.map((w) => [w.kind, w.usedPercent, w.observedAt]), [['session', 90, 200], ['weekly', 20, 100]]);
  assert.equal(merged.fetchedAt, 100);
  assert.equal(mergeClaudeReadings([a]), a);
  assert.equal(mergeClaudeReadings([a, snapOf([win('session', 5, 50)], 50)]), a);
  assert.equal(mergeClaudeReadings([null, { ok: false }]), null);
});

test('merge: commit-time reconciliation keeps newer stored windows over a late older result', () => {
  const stored = snapOf([win('session', 90, 2000)], 2000);
  const late = snapOf([win('session', 10, 1000)], 1000, { stale: true, lastError: { code: 'HTTP_429' } });
  assert.equal(reconcileClaudeReadings(stored, late, 3000), stored);
  const newer = snapOf([win('session', 30, 4000)], 4000);
  assert.equal(reconcileClaudeReadings(stored, newer, 5000), newer);
  const mixed = reconcileClaudeReadings(snapOf([win('session', 90, 2000)], 2000),
    snapOf([win('session', 10, 1000), win('weekly', 40, 1500)], 1000, { lastError: { code: 'HTTP_429' } }), 3000);
  assert.deepEqual(mixed.windows.map((w) => [w.kind, w.usedPercent]), [['session', 90], ['weekly', 40]]);
  assert.equal(mixed.stale, true, 'a window left over from a failed top-up stays flagged');
});

// ------------------------------------------------------------ credentials and identity (pass B)

test('claude api: only plain visible-ASCII tokens are ever placed in a header', async () => {
  for (const token of ['abc\ndef-secret-tail', 'has space', 'tab\there', 'x'.repeat(5000), 'café-token', '']) {
    const h = harness({ token });
    const snap = await fetchClaudeQuotas(h.deps);
    assert.equal(h.calls.length, 0, `no request for ${JSON.stringify(token).slice(0, 20)}`);
    assert.equal(snap.error.code, 'NO_AUTH');
    assert.doesNotMatch(JSON.stringify(snap), /def-secret-tail|has space/);
  }
  assert.equal(readClaudeAuth(harness({ token: 'sk-ant-oat01_ok.token~+/=' }).deps).token, 'sk-ant-oat01_ok.token~+/=');
});

test('claude api: reproduction - transport exception text never reaches the snapshot', async () => {
  const h = harness();
  h.deps.fetchImpl = async (_url, init) => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: new TypeError(`Headers.append: ${init.headers.Authorization} is an invalid header value`),
    });
  };
  const snap = await fetchClaudeQuotas(h.deps);
  assert.equal(snap.error.code, 'NETWORK');
  assert.equal(snap.error.message, 'Claude usage API unreachable');
  assert.doesNotMatch(JSON.stringify(snap), /tok-secret|Bearer/);
});

test('claude credentials: symlinks, reparse points and files that resolve outside the profile are never read', async () => {
  const link = harness();
  link.cred.symlink = true;
  assert.equal(readClaudeAuth(link.deps), null);
  assert.equal((await fetchClaudeQuotas(link.deps)).error.code, 'NO_AUTH');
  assert.equal(link.calls.length, 0);

  const escaped = harness();
  escaped.deps.credentialFs.realpathSync = (p) => (p.endsWith('.credentials.json') ? path.resolve('elsewhere', '.credentials.json') : p);
  assert.equal(readClaudeAuth(escaped.deps), null);

  for (const bad of [`${CONFIG_DIR}${path.sep}..${path.sep}other`, 'relative/profile', `${CONFIG_DIR}\0x`]) {
    assert.equal(readClaudeAuth(harness({ configDir: bad }).deps), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(readClaudeAuth(harness().deps).token, 'tok-secret');
});

test('claude credentials: a real symlink to another folder is rejected on this machine', (t) => {
  const dir = tempDir();
  try {
    const profile = path.join(dir, 'profile');
    const other = path.join(dir, 'other');
    fs.mkdirSync(profile);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'creds.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'real-token' } }));
    try { fs.symlinkSync(path.join(other, 'creds.json'), path.join(profile, '.credentials.json')); }
    catch { t.skip('symlinks need privileges here'); return; }
    assert.equal(readClaudeAuth({ configDir: profile }), null);
    fs.rmSync(path.join(profile, '.credentials.json'));
    fs.writeFileSync(path.join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'real-token' } }));
    assert.equal(readClaudeAuth({ configDir: profile }).token, 'real-token');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('budget constants are sane', () => {
  assert.ok(BACKOFF_MS.every((ms, i) => i === 0 || ms >= BACKOFF_MS[i - 1]));
  assert.equal(MAX_RETRY_AFTER_MS, 24 * HOUR);
});

// ---- model-specific weekly limits (API top-up only) ----
const scoped = (name, percent = 0, id = null, resets = new Date(T0 + 24 * HOUR).toISOString()) => ({
  kind: 'weekly_scoped', group: 'weekly', percent, resets_at: resets, scope: { model: { id, display_name: name }, surface: null },
});
const withLimits = (limits) => ({ ...apiBody, limits });
const models = (snap) => snap.windows.filter((w) => w.kind === 'other');

test('claude api models: zero, one and many scoped limits; null id falls back to the name', () => {
  assert.equal(models(normalizeClaudeApiUsage(withLimits([]), null, T0)).length, 0);
  assert.equal(models(normalizeClaudeApiUsage(apiBody, null, T0)).length, 0);
  const one = normalizeClaudeApiUsage(withLimits([
    { kind: 'session', percent: 3, resets_at: new Date(T0 + HOUR).toISOString(), scope: null },
    { kind: 'weekly_all', percent: 1, resets_at: new Date(T0 + HOUR).toISOString(), scope: null },
    scoped('Fable', 0),
  ]), null, T0);
  assert.equal(one.windows.length, 3);
  assert.deepEqual(models(one).map((w) => [w.id, w.label, w.usedPercent, w.periodSeconds, w.observedAt]),
    [['claude:model:fable', 'Fable', 0, 604800, T0]]);
  const many = normalizeClaudeApiUsage(withLimits(Array.from({ length: 10 }, (_, i) => scoped(`Model ${i}`, i, `m${i}`))), null, T0);
  assert.equal(models(many).length, 6);
  assert.equal(models(many)[0].id, 'claude:model:m0');
  const dup = normalizeClaudeApiUsage(withLimits([scoped('Fable', 1), scoped('Fable', 2)]), null, T0);
  assert.equal(models(dup).length, 1);
});

test('claude api models: malformed, expired, surface-only and hostile entries are handled', () => {
  const past = new Date(T0 - HOUR).toISOString();
  const snap = normalizeClaudeApiUsage(withLimits([
    scoped('Expired', 5, 'e', past),
    scoped('Neg', -1), scoped('Big', 101), scoped('NaN', NaN), scoped('Str', '5'),
    { kind: 'weekly_scoped', percent: 5, resets_at: new Date(T0 + HOUR).toISOString(), scope: { model: null, surface: { display_name: 'Web' } } },
    { kind: 'weekly_scoped', percent: 5, resets_at: 'garbage', scope: { model: { display_name: 'BadReset' } } },
    null, 'x', { kind: 'weekly_scoped' },
    scoped('<img src=x onerror=alert(1)>Evil\n\u202e"&\'' + 'x'.repeat(200), 7),
    scoped('<>', 8),
  ]), null, T0);
  const found = models(snap);
  assert.equal(found.length, 1);
  assert.match(found[0].label, /^[\p{L}\p{N} .\-_+()]+$/u);
  assert.ok(found[0].label.length <= 40);
  assert.ok(!/[<>&"'\n]/.test(found[0].label + found[0].id));
  assert.match(found[0].id, /^claude:model:[a-z0-9-]+$/);
});

test('claude api models: a scoped limit alone does not make a reading', () => {
  const snap = normalizeClaudeApiUsage({ limits: [scoped('Fable')] }, null, T0);
  assert.equal(snap.error.code, 'NO_DATA');
});

test('claude api models: local capture keeps them within the cutoff, drops them after it or after reset', async () => {
  const api = normalizeClaudeApiUsage(withLimits([scoped('Fable', 4, null, new Date(T0 + 2 * HOUR).toISOString())]), null, T0);
  const local = (at) => ({ ok: true, source: 'claude-statusline', fetchedAt: at, notes: ['From Claude Code status line'],
    windows: [{ id: 'claude:session', kind: 'session', label: '5 hr', usedPercent: 9, resetsAt: new Date(T0 + 3 * HOUR).toISOString(), periodSeconds: 18000, observedAt: at },
      { id: 'claude:weekly', kind: 'weekly', label: 'Week', usedPercent: 9, resetsAt: new Date(T0 + 3 * HOUR).toISOString(), periodSeconds: 604800, observedAt: at }] });
  const now = T0 + 10 * MIN;
  const merged = mergeClaudeReadings([api, local(now - MIN)], now);
  assert.deepEqual(merged.windows.map((w) => w.kind), ['session', 'weekly', 'other']);
  assert.equal(merged.windows[0].usedPercent, 9);
  assert.equal(merged.fetchedAt, now - MIN, 'model windows never set freshness');
  assert.equal(models(merged)[0].observedAt, T0, 'keeps the API observation time');
  // Identity is preserved when nothing is combined.
  assert.equal(mergeClaudeReadings([api], T0), api);
  // Older than the stale cutoff or past its reset: removed.
  const late = T0 + API_STALE_MS + MIN;
  assert.equal(models(mergeClaudeReadings([api, local(late - MIN)], late)).length, 0);
  const after = T0 + 3 * HOUR;
  assert.equal(models(mergeClaudeReadings([{ ...api, windows: api.windows.map((w) => ({ ...w, observedAt: after - MIN })) }, local(after - MIN)], after)).length, 0);
  // A newer API reading replaces the earlier value.
  const newer = normalizeClaudeApiUsage(withLimits([scoped('Fable', 9, null, new Date(T0 + 2 * HOUR).toISOString())]), null, T0 + 5 * MIN);
  assert.equal(models(mergeClaudeReadings([api, newer], T0 + 6 * MIN))[0].usedPercent, 9);
});

test('claude api models: flow through a top-up fetch and the reading cache', async () => {
  const { safeReading } = require('../src/main/readingCache');
  const h = harness({ local: null, body: withLimits([scoped('Fable', 3, null, new Date(T0 + 24 * HOUR).toISOString())]) });
  const snap = await fetchClaudeQuotas(h.deps);
  assert.equal(models(snap).length, 1);
  const stored = safeReading('claude', JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(models(stored).map((w) => [w.id, w.label, w.usedPercent, w.observedAt]), [['claude:model:fable', 'Fable', 3, T0]]);
  // Next poll: fresh local capture, no API call, model limit survives.
  const h2 = harness({ previous: stored, apiTopUp: true, local: usageFile(h.c, { session: [10, MIN], weekly: [11, MIN] }) });
  const again = await fetchClaudeQuotas(h2.deps);
  assert.equal(h2.calls.length, 0);
  assert.equal(models(again).length, 1);
  const { shapeProvider } = require('../src/main/snapshotView');
  assert.equal(shapeProvider('claude', again, { enabled: true, activeAlerts: {}, now: T0 }).extras[0].label, 'Fable');
});
