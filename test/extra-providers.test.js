'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { fetchGrokQuotas, normalizeGrokKeyInfo, findCreditPair } = require('../src/main/providers/grok');
const { fetchGeminiQuotas, normalizeGeminiKeyCheck } = require('../src/main/providers/gemini');
const { fetchOpenRouterQuotas, normalizeOpenRouter } = require('../src/main/providers/openrouter');
const { createRegistry } = require('../src/main/providers');
const { sanitize } = require('../src/main/settings');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const getKey = async () => 'test-key-1234567890';

// ---- registry ----

test('registry includes all six providers', () => {
  const ids = createRegistry().map((p) => p.id);
  assert.deepEqual(ids, ['codex', 'claude', 'zai', 'grok', 'gemini', 'openrouter']);
});

// ---- settings schema ----

test('settings: new providers default off and accept booleans', () => {
  const def = sanitize({});
  assert.equal(def.providers.grok, false);
  assert.equal(def.providers.gemini, false);
  assert.equal(def.providers.openrouter, false);
  assert.equal(def.providers.codex, true);
  const patched = sanitize({ providers: { grok: true, openrouter: true } });
  assert.equal(patched.providers.grok, true);
  assert.equal(patched.providers.gemini, false);
});

// ---- grok ----

test('grok: maps a credit pair when xAI exposes usage', () => {
  const snap = normalizeGrokKeyInfo(fixture('grok-apikey.json'));
  assert.equal(snap.ok, true);
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].kind, 'weekly');
  assert.equal(snap.windows[0].usedPercent, Math.round((4.2 / 25) * 1000) / 10);
});

test('grok: unknown shape -> key-valid card with honest notes', () => {
  const snap = normalizeGrokKeyInfo({ data: { name: 'dev' } });
  assert.equal(snap.ok, true);
  assert.equal(snap.windows.length, 0);
  assert.ok(snap.notes.some((n) => /no usage\/quota API/.test(n)));
});

test('grok: findCreditPair ignores non-numeric junk', () => {
  assert.equal(findCreditPair({ usage: 'x', limit: 'y' }), null);
  assert.equal(findCreditPair(null), null);
});

test('grok: transport errors map to codes', async () => {
  const fetch401 = async () => jsonRes({}, 401);
  const snap = await fetchGrokQuotas({ getKey, fetchImpl: fetch401 });
  assert.equal(snap.ok, false);
  assert.equal(snap.error.code, 'NO_AUTH');
  const noKey = await fetchGrokQuotas({ getKey: async () => null, fetchImpl: fetch401 });
  assert.equal(noKey.error.code, 'NO_KEY');
});

// ---- gemini ----

test('gemini: valid key -> ok snapshot with tier notes, no windows', () => {
  const snap = normalizeGeminiKeyCheck(fixture('gemini-models.json'));
  assert.equal(snap.ok, true);
  assert.equal(snap.plan, 'AI Studio');
  assert.equal(snap.windows.length, 0);
  assert.ok(snap.notes.some((n) => /no usage\/quota API/.test(n)));
  assert.ok(snap.notes.some((n) => /15 RPM/.test(n)));
});

test('gemini: rejected key -> NO_AUTH', async () => {
  const snap = await fetchGeminiQuotas({ getKey, fetchImpl: async () => jsonRes({ error: { code: 403 } }, 403) });
  assert.equal(snap.ok, false);
  assert.equal(snap.error.code, 'NO_AUTH');
});

test('gemini: key travels in header, never in URL', async () => {
  let seen = null;
  const snap = await fetchGeminiQuotas({
    getKey,
    fetchImpl: async (url, opts) => {
      seen = { url, headers: opts.headers };
      return jsonRes(fixture('gemini-models.json'));
    },
  });
  assert.equal(snap.ok, true);
  assert.ok(!seen.url.includes('test-key'), 'key must not appear in the URL');
  assert.equal(seen.headers['x-goog-api-key'], 'test-key-1234567890');
});

// ---- openrouter ----

test('openrouter: key with limit maps to credit budget window', () => {
  const snap = normalizeOpenRouter(fixture('openrouter-key.json').data, null);
  assert.equal(snap.ok, true);
  const w = snap.windows[0];
  assert.equal(w.kind, 'weekly');
  assert.equal(w.usedPercent, Math.round((2.53 / 10) * 1000) / 10);
  assert.equal(w.resetsAt, null); // credits do not reset
  assert.ok(snap.notes.some((n) => /Rate limit: 20 req\/10s/.test(n)));
});

test('openrouter: paygo key falls back to prepaid credits', () => {
  const snap = normalizeOpenRouter({ usage: 1, limit: 0, is_free_tier: true }, { total_credits: 5, total_credits_used: 1.25 });
  assert.equal(snap.windows[0].usedPercent, 25);
  assert.equal(snap.plan, 'free tier');
  assert.ok(snap.notes.some((n) => /Pay-as-you-go/.test(n)));
});

test('openrouter: no usable numbers -> honest note, no window', () => {
  const snap = normalizeOpenRouter({ usage: 0, limit: 0 }, null);
  assert.equal(snap.windows.length, 0);
  assert.ok(snap.notes.some((n) => /No spendable credit limit/.test(n)));
});

test('openrouter: fetch queries /key then /credits only for paygo keys', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith('/api/v1/key')) return jsonRes({ data: { usage: 1, limit: 0 } });
    return jsonRes({ data: { total_credits: 10, total_credits_used: 2 } });
  };
  const snap = await fetchOpenRouterQuotas({ getKey, fetchImpl });
  assert.equal(snap.ok, true);
  assert.equal(snap.windows[0].usedPercent, 20);
  assert.equal(urls.length, 2);
});
