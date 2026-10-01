'use strict';
const { AbortController } = globalThis;

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
const RATE_LIMIT_BASE_MS = 15 * 60_000;
const RATE_LIMIT_MAX_MS = 2 * 60 * 60_000;
const rateLimitState = new Map();

function isRetryable(code) {
  if (RETRYABLE.has(code)) return true;
  return /^HTTP_5\d\d$/.test(code);
}

function withTimeout(work, ms, signal) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let t = null;
    let workPromise = null;
    let cleanupTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      clearTimeout(cleanupTimer);
      if (signal) signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancelWork = (code, message) => {
      if (settled) return;
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', cancel);
      const error = Object.assign(new Error(message), { code });
      controller.abort();
      // Give cooperative transports time to finish cleanup; never retry
      // work whose cancellation has not completed within this bound.
      cleanupTimer = setTimeout(() => { error.retrySafe = false; finish(error); }, 250);
      if (workPromise) workPromise.then(
        (snap) => { error.retrySafe = !(snap && snap.retrySafe === false); finish(error); },
        () => finish(error),
      );
      else finish(error);
    };
    const cancel = () => cancelWork('ABORTED', 'poll aborted');
    if (signal && signal.aborted) { cancel(); return; }
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    t = setTimeout(() => {
      cancelWork('TIMEOUT', 'poll timeout');
    }, ms);
    workPromise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    });
    workPromise.then((v) => { if (!controller.signal.aborted) finish(null, v); }, (e) => { if (!controller.signal.aborted) finish(e); });
  });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    if (signal) {
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    }
  });
}

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
  const now = deps.now || Date.now;
  const cooldowns = deps.rateLimitState || rateLimitState;
  const cooldown = cooldowns.get(provider.id);
  if (cooldown && now() < cooldown.retryAt) {
    return {
      providerId: provider.id,
      ok: false,
      cooldown: true,
      error: { code: 'HTTP_429', message: `Rate limited; retry after ${new Date(cooldown.retryAt).toISOString()}`, retryAt: cooldown.retryAt },
      fetchedAt: now(),
    };
  }

  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const snap = await withTimeout((signal) => fetchQuotas({ ...deps, signal }), timeoutMs, deps.signal);
      if (snap && snap.ok) {
        cooldowns.delete(provider.id);
        return snap;
      }
      last = snap; // structured error snapshot; do not retry non-retryable codes
      const code = last && last.error ? last.error.code : '';
      if (code === 'HTTP_429') {
        const failures = Math.min((cooldown ? cooldown.failures : 0) + 1, 5);
        const delay = Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** (failures - 1));
        const retryAt = now() + delay;
        cooldowns.set(provider.id, { failures, retryAt });
        last = { ...last, error: { ...last.error, retryAt } };
      } else {
        cooldowns.delete(provider.id);
      }
      if (attempt < retries && isRetryable(code)) {
        if (last && last.retrySafe === false) return last;
        await sleep(200 + Math.floor(random() * maxBackoffMs), deps.signal);
        continue;
      }
      return last;
    } catch (cause) {
      const code = cause && ['TIMEOUT', 'ABORTED'].includes(cause.code) ? cause.code : 'NETWORK';
      last = {
        providerId: provider.id,
        ok: false,
        error: { code, message: String(cause && cause.message).slice(0, 300) },
        fetchedAt: Date.now(),
      };
      if (attempt < retries && isRetryable(code) && cause.retrySafe !== false) {
        await sleep(200 + Math.floor(random() * maxBackoffMs), deps.signal);
        continue;
      }
      return last;
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
      merged[id] = { ...snap, stale: !!snap.stale };
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
function createRegistry({ zaiDeps = {}, grokDeps = {}, geminiDeps = {}, openrouterDeps = {}, claudeProfiles = [], codexProfiles = [] } = {}) {
  const adapterDeps = (shared = {}, own = {}) => {
    // Endpoint overrides belong to one provider; a shared URL must never
    // redirect another provider's authentication header to that host.
    const isolated = { ...shared };
    delete isolated.baseUrl;
    return { ...isolated, ...own };
  };
  return [
    { id: 'codex', title: 'Codex', fetchQuotas: (deps) => fetchCodexQuotas(deps) },
    ...codexProfiles.map((profile) => ({
      id: profile.id,
      title: profile.label,
      fetchQuotas: async (deps) => {
        const snapshot = await fetchCodexQuotas({ ...deps, codexHome: profile.configDir });
        return { ...snapshot, providerId: profile.id };
      },
    })),
    { id: 'claude', title: 'Claude', fetchQuotas: (deps) => fetchClaudeQuotas(deps) },
    ...claudeProfiles.map((profile) => ({
      id: profile.id,
      title: profile.label,
      fetchQuotas: async (deps) => {
        const snapshot = await fetchClaudeQuotas({ ...deps, configDir: profile.configDir });
        return { ...snapshot, providerId: profile.id };
      },
    })),
    { id: 'zai', title: 'Z.ai', fetchQuotas: (deps) => fetchZaiQuotas(adapterDeps(deps, zaiDeps)) },
    { id: 'grok', title: 'Grok', fetchQuotas: (deps) => fetchGrokQuotas(adapterDeps(deps, grokDeps)) },
    { id: 'gemini', title: 'Gemini', fetchQuotas: (deps) => fetchGeminiQuotas(adapterDeps(deps, geminiDeps)) },
    { id: 'openrouter', title: 'OpenRouter', fetchQuotas: (deps) => fetchOpenRouterQuotas(adapterDeps(deps, openrouterDeps)) },
  ];
}

module.exports = { pollProvider, pollAll, mergeWithCache, createRegistry, isRetryable };
