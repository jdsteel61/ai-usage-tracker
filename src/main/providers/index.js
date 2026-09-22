'use strict';

/**
 * Provider orchestrator.
 *
 * Every adapter is isolated behind `poll(snapshot) -> Snapshot`. Polls run
 * independently with a timeout and at most one bounded retry (never retried:
 * NO_AUTH / NO_CLI / NO_KEY — retrying those is pointless or harmful). One
 * provider failing never blanks the others: results are merged with the
 * last-success cache, and a failed provider keeps showing its cached value
 * with an explicit stale age.
 */
const { fetchCodexQuotas } = require('./codex');
const { fetchClaudeQuotas } = require('./claude');
const { fetchZaiQuotas } = require('./zai');
const { fetchGrokQuotas } = require('./grok');
const { fetchGeminiQuotas } = require('./gemini');
const { fetchOpenRouterQuotas } = require('./openrouter');

const DEFAULT_TIMEOUT_MS = 20_000;
const RETRYABLE = new Set(['TIMEOUT', 'NETWORK', 'EXIT', 'RPC', 'HTTP_5xx']);

function isRetryable(code) {
  if (RETRYABLE.has(code)) return true;
  return /^HTTP_5\d\d$/.test(code);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('poll timeout'), { code: 'TIMEOUT' })), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll one provider with timeout + single bounded retry and jittered backoff.
 * `deps`: { fetchQuotas, timeoutMs, retries, maxBackoffMs, random }.
 */
async function pollProvider(provider, deps = {}) {
  const fetchQuotas = deps.fetchQuotas || provider.fetchQuotas;
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = deps.retries === undefined ? 1 : deps.retries;
  const maxBackoffMs = deps.maxBackoffMs || 2000;
  const random = deps.random || Math.random;

  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const snap = await withTimeout(Promise.resolve().then(() => fetchQuotas(deps)), timeoutMs);
      if (snap && snap.ok) return snap;
      last = snap; // structured error snapshot; do not retry non-retryable codes
      const code = last && last.error ? last.error.code : '';
      if (attempt < retries && isRetryable(code)) {
        await sleep(200 + Math.floor(random() * maxBackoffMs));
        continue;
      }
      return last;
    } catch (cause) {
      const code = cause && cause.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK';
      last = {
        providerId: provider.id,
        ok: false,
        error: { code, message: String(cause && cause.message).slice(0, 300) },
        fetchedAt: Date.now(),
      };
      if (attempt < retries && isRetryable(code)) {
        await sleep(200 + Math.floor(random() * maxBackoffMs));
        continue;
      }
    }
  }
  return last;
}

/**
 * Run all enabled providers independently. Returns a map keyed by provider id.
 * Adapters are passed via `providers` for testability; production registry
 * comes from createRegistry().
 */
async function pollAll(providers, deps = {}) {
  const entries = await Promise.allSettled(
    providers.map(async (p) => [p.id, await pollProvider(p, { ...deps, fetchQuotas: p.fetchQuotas })]),
  );
  const out = {};
  for (const entry of entries) {
    if (entry.status === 'fulfilled') out[entry.value[0]] = entry.value[1];
    else {
      // pollProvider never rejects, but keep the isolation guarantee anyway.
      const provider = providers.find((p) => !out[p.id]);
      out[provider ? provider.id : 'unknown'] = {
        providerId: provider ? provider.id : 'unknown',
        ok: false,
        error: { code: 'NETWORK', message: 'unexpected failure' },
        fetchedAt: Date.now(),
      };
    }
  }
  return out;
}

/**
 * Merge fresh results with the last-success cache. A provider that just
 * failed keeps its previous good windows, flagged `stale: true` with the
 * original fetchedAt so the UI can show the age.
 */
function mergeWithCache(fresh, cache = {}) {
  const merged = {};
  for (const id of Object.keys(fresh)) {
    const snap = fresh[id];
    if (snap && snap.ok) {
      merged[id] = { ...snap, stale: false };
    } else {
      const cached = cache[id];
      if (cached && cached.ok) {
        merged[id] = { ...cached, stale: true, lastError: snap && snap.error ? snap.error : null };
      } else {
        merged[id] = snap;
      }
    }
  }
  return merged;
}

/** Production registry. Per-provider `getKey` deps are wired to Credential Manager. */
function createRegistry({ zaiDeps = {}, grokDeps = {}, geminiDeps = {}, openrouterDeps = {} } = {}) {
  return [
    { id: 'codex', title: 'Codex', fetchQuotas: (deps) => fetchCodexQuotas(deps) },
    { id: 'claude', title: 'Claude', fetchQuotas: (deps) => fetchClaudeQuotas(deps) },
    { id: 'zai', title: 'Z.ai', fetchQuotas: (deps) => fetchZaiQuotas({ ...deps, ...zaiDeps }) },
    { id: 'grok', title: 'Grok', fetchQuotas: (deps) => fetchGrokQuotas({ ...deps, ...grokDeps }) },
    { id: 'gemini', title: 'Gemini', fetchQuotas: (deps) => fetchGeminiQuotas({ ...deps, ...geminiDeps }) },
    { id: 'openrouter', title: 'OpenRouter', fetchQuotas: (deps) => fetchOpenRouterQuotas({ ...deps, ...openrouterDeps }) },
  ];
}

module.exports = { pollProvider, pollAll, mergeWithCache, createRegistry, isRetryable };
