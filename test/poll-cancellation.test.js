'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AbortController } = globalThis;
const { pollProvider, createRegistry } = require('../src/main/providers');
const { fetchCodexQuotas } = require('../src/main/providers/codex');
const { Scheduler } = require('../src/main/scheduler');

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('timeouts abort HTTP transport before retry starts for every network provider', async () => {
  for (const id of ['zai', 'grok', 'gemini', 'openrouter']) {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const provider = createRegistry({ [`${id}Deps`]: { getKey: async () => 'fake-key' } }).find((p) => p.id === id);
    const result = await pollProvider(provider, {
      timeoutMs: 10, retries: 1, random: () => 0,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        calls++; active++; maximum = Math.max(maximum, active);
        signal.addEventListener('abort', () => { active--; reject(new Error('cancelled')); }, { once: true });
      }),
    });
    assert.equal(result.error.code, 'TIMEOUT');
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
    assert.equal(active, 0);
  }
});

test('external abort cancels transport and never retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const resultPromise = pollProvider({ id: 'cancel', fetchQuotas: ({ signal }) => new Promise((_resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) }, { signal: controller.signal, retries: 2 });
  await nextTurn();
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.error.code, 'ABORTED');
  assert.equal(calls, 1);
});

test('late key lookup after cancellation never starts a HTTP request', async () => {
  for (const id of ['zai', 'grok', 'gemini', 'openrouter']) {
    const controller = new AbortController();
    let release;
    let requests = 0;
    const provider = createRegistry({ [`${id}Deps`]: { getKey: () => new Promise((resolve) => { release = resolve; }) } }).find((p) => p.id === id);
    const pending = pollProvider(provider, { signal: controller.signal, retries: 0, fetchImpl: () => { requests++; throw new Error('unexpected request'); } });
    await nextTurn();
    controller.abort();
    release('fake-key');
    assert.equal((await pending).error.code, 'ABORTED');
    assert.equal(requests, 0);
  }
});

test('uncooperative timed out work is bounded and never overlapped by retry', async () => {
  let calls = 0;
  const snap = await pollProvider({ id: 'uncooperative', fetchQuotas: () => {
    calls++;
    return new Promise(() => {});
  } }, { timeoutMs: 10, retries: 1 });
  assert.equal(snap.error.code, 'TIMEOUT');
  assert.equal(calls, 1);
});

test('abort during retry backoff skips the next attempt promptly', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = pollProvider({ id: 'backoff', fetchQuotas: async () => {
    calls++;
    return { ok: false, error: { code: 'NETWORK' } };
  } }, { signal: controller.signal, retries: 1, maxBackoffMs: 5000, random: () => 1 });
  await nextTurn();
  controller.abort();
  assert.equal((await pending).error.code, 'ABORTED');
  assert.equal(calls, 1);
});

test('Codex cancellation kills the subprocess and cleans listeners', async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0;
  let exited = false;
  child.kill = () => { kills++; setTimeout(() => { exited = true; child.emit('exit', 0); }, 25); };
  const pending = fetchCodexQuotas({ signal: controller.signal, target: { exe: 'fake', args: [] }, spawnImpl: () => child });
  controller.abort();
  assert.equal((await pending).error.code, 'ABORTED');
  assert.equal(kills, 1);
  assert.equal(exited, true, 'adapter settles only after subprocess exit');
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
});

test('scheduler restart aborts prior generation and runs next after it settles', async () => {
  const runs = [];
  let release;
  const scheduler = new Scheduler(async (signal) => {
    runs.push(signal);
    if (runs.length === 1) await new Promise((resolve) => { release = resolve; });
  }, { setIntervalMs: () => 0 });
  scheduler.start(5);
  scheduler.start(5);
  assert.equal(runs[0].aborted, true);
  assert.equal(runs.length, 1);
  release();
  await nextTurn();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].aborted, false);
  scheduler.stop();
});

test('Codex timeout waits for delayed subprocess exit before retry', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const snap = await pollProvider({ id: 'codex-cancel', fetchQuotas: fetchCodexQuotas }, {
    timeoutMs: 10, retries: 1, random: () => 0,
    target: { exe: 'fake', args: [] },
    spawnImpl: () => {
      calls++; active++; maximum = Math.max(maximum, active);
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => setTimeout(() => { active--; child.emit('exit', 0); }, 50);
      return child;
    },
  });
  assert.equal(snap.error.code, 'TIMEOUT');
  assert.equal(calls, 2);
  assert.equal(active, 0);
  assert.equal(maximum, 1);
});
