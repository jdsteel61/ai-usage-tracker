'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pollProvider, pollAll, mergeWithCache, isRetryable } = require('../src/main/providers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function okSnap(id, pct = 10) {
  return { providerId: id, ok: true, plan: null, notes: [], fetchedAt: Date.now(), windows: [{ id: `${id}:session`, kind: 'session', label: '5 hr', usedPercent: pct, resetsAt: null, periodSeconds: 18000 }] };
}
function errSnap(id, code) {
  return { providerId: id, ok: false, error: { code, message: 'x' }, fetchedAt: Date.now() };
}

test('one provider failing does not stop the others', async () => {
  const providers = [
    { id: 'a', fetchQuotas: async () => okSnap('a') },
    { id: 'b', fetchQuotas: async () => { throw new Error('kaboom'); } },
    { id: 'c', fetchQuotas: async () => errSnap('c', 'NO_AUTH') },
  ];
  const out = await pollAll(providers, { timeoutMs: 500, retries: 0 });
  assert.equal(out.a.ok, true);
  assert.equal(out.b.ok, false);
  assert.equal(out.b.error.code, 'NETWORK');
  assert.equal(out.c.ok, false);
  assert.equal(out.c.error.code, 'NO_AUTH');
});

test('provider timeout produces TIMEOUT, others continue', async () => {
  const providers = [
    { id: 'slow', fetchQuotas: () => sleep(600).then(() => okSnap('slow')) },
    { id: 'fast', fetchQuotas: async () => okSnap('fast') },
  ];
  const out = await pollAll(providers, { timeoutMs: 50, retries: 0, maxBackoffMs: 1 });
  assert.equal(out.slow.error.code, 'TIMEOUT');
  assert.equal(out.fast.ok, true);
});

test('transient failures retry once, auth failures do not', async () => {
  let calls = 0;
  let provider = { id: 'x', fetchQuotas: async () => { calls++; if (calls === 1) throw new Error('transient'); return okSnap('x'); } };
  const snap = await pollProvider(provider, { timeoutMs: 500, retries: 1, maxBackoffMs: 1, random: () => 0 });
  assert.equal(snap.ok, true);
  assert.equal(calls, 2);

  let authCalls = 0;
  provider = { id: 'y', fetchQuotas: async () => { authCalls++; return errSnap('y', 'NO_AUTH'); } };
  const snap2 = await pollProvider(provider, { timeoutMs: 500, retries: 1, maxBackoffMs: 1, random: () => 0 });
  assert.equal(snap2.ok, false);
  assert.equal(authCalls, 1, 'auth errors are not retried');
});

test('isRetryable classification', () => {
  assert.equal(isRetryable('TIMEOUT'), true);
  assert.equal(isRetryable('NETWORK'), true);
  assert.equal(isRetryable('HTTP_503'), true);
  assert.equal(isRetryable('HTTP_429'), false);
  assert.equal(isRetryable('NO_AUTH'), false);
  assert.equal(isRetryable('NO_CLI'), false);
  assert.equal(isRetryable('NO_KEY'), false);
});

test('failed provider keeps cached windows flagged stale with age', () => {
  const cached = okSnap('a');
  cached.fetchedAt = Date.now() - 12 * 60_000;
  const fresh = { a: errSnap('a', 'NETWORK') };
  const merged = mergeWithCache(fresh, { a: cached });
  assert.equal(merged.a.ok, true);
  assert.equal(merged.a.stale, true);
  assert.equal(merged.a.lastError.code, 'NETWORK');
  assert.ok(Math.abs((Date.now() - merged.a.fetchedAt) - 12 * 60_000) < 5000);
});

test('successful provider is not marked stale', () => {
  const merged = mergeWithCache({ a: okSnap('a') }, {});
  assert.equal(merged.a.stale, false);
});

test('provider with no cache shows the error outright', () => {
  const merged = mergeWithCache({ a: errSnap('a', 'NO_KEY') }, {});
  assert.equal(merged.a.ok, false);
  assert.equal(merged.a.error.code, 'NO_KEY');
});
