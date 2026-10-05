'use strict';

/** Claude usage: local status-line capture first, with an opt-in API top-up.
 * Local capture reads only the usage file Claude Code's status line wrote. The
 * API top-up (off by default, per profile) runs only when the newest reading
 * is older than API_TOPUP_AFTER_MS, behind the claudeApiBudget rate budget.
 * It reads the access token from the profile's .credentials.json and sends
 * it to the usage endpoint. It never writes or refreshes credentials. */
const fs = require('fs');
const { usagePath } = require('../claudeStatusline');
const { parseRetryAfter } = require('../claudeApiBudget');
const { resolveCredentialFile } = require('../claudeCredentials');
const { mergeClaudeReadings, staleLimit, LOCAL_STALE_MS, API_STALE_MS } = require('../claudeMerge');
const { CLAUDE_LOCAL_NOTE, CLAUDE_API_NOTE, clampPercent, okSnapshot, errorSnapshot } = require('./model');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USER_AGENT = 'ai-usage-tracker/1.5 (claude-usage-topup)';
const API_TOPUP_AFTER_MS = 25 * 60_000;
const API_TIMEOUT_MS = 15_000;
const TOKEN_RE = /^[!-~]{1,4096}$/; // visible ASCII only: safe to place in a header
const WINDOW_SPECS = [
  ['five_hour', 'session', '5 hr', 5 * 3600],
  ['seven_day', 'weekly', 'Week', 7 * 24 * 3600],
];

function normalizeClaudeUsage(data, now = Date.now()) {
  const windows = [];
  const timestamps = [];
  for (const [key, kind, label, periodSeconds] of WINDOW_SPECS) {
    const w = data && data.windows && data.windows[key];
    if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
        || !Number.isFinite(w.observedAt) || w.observedAt > now
        || !(Date.parse(w.resetsAt) > now)) continue;
    windows.push({ id: `claude:${kind}`, kind, label, usedPercent: w.usedPercent,
      resetsAt: w.resetsAt, periodSeconds, observedAt: w.observedAt });
    timestamps.push(w.observedAt);
  }
  if (!windows.length) return errorSnapshot('claude', 'NO_DATA',
    'No current Claude usage captured. Enable local capture in Settings, then use Claude Code.');
  const fetchedAt = Math.min(...timestamps);
  return { ...okSnapshot('claude', { windows, fetchedAt, notes: [CLAUDE_LOCAL_NOTE] }),
    source: 'claude-statusline', stale: now - fetchedAt > LOCAL_STALE_MS };
}

/** Pure: the usage endpoint's { five_hour|seven_day: { utilization, resets_at } }. */
function normalizeClaudeApiUsage(body, auth, now = Date.now()) {
  const windows = [];
  for (const [key, kind, label, periodSeconds] of WINDOW_SPECS) {
    const w = body && body[key];
    const usedPercent = w ? clampPercent(w.utilization) : null;
    const resetsAt = w ? Date.parse(w.resets_at) : NaN;
    if (usedPercent === null || !(resetsAt > now)) continue;
    windows.push({ id: `claude:${kind}`, kind, label, usedPercent,
      resetsAt: new Date(resetsAt).toISOString(), periodSeconds, observedAt: now });
  }
  if (!windows.length) return errorSnapshot('claude', 'NO_DATA', 'Claude usage API returned no current subscription windows');
  return { ...okSnapshot('claude', { plan: auth && auth.plan ? String(auth.plan).slice(0, 40) : null,
    windows, fetchedAt: now, notes: [CLAUDE_API_NOTE] }), source: 'claude-api', stale: false };
}

/** Read-only token access. null when signed out or the credential file is not
 * a plain file inside the profile folder; { mtimeMs } is what the budget watches
 * to learn that the user signed in again. A token that is not plain visible
 * ASCII is treated as no usable login and is never put in a header. */
function readClaudeAuth(deps = {}) {
  const resolved = resolveCredentialFile(deps.configDir, deps.credentialFs);
  if (!resolved.ok) return null;
  const { mtimeMs } = resolved;
  let raw;
  try { raw = (deps.readFileSync || fs.readFileSync)(resolved.file, 'utf8'); } catch { return null; }
  try {
    const oauth = (JSON.parse(raw) || {}).claudeAiOauth || {};
    if (typeof oauth.accessToken !== 'string' || !TOKEN_RE.test(oauth.accessToken)) return { token: null, mtimeMs };
    return { token: oauth.accessToken, plan: oauth.subscriptionType || null, mtimeMs };
  } catch { return { token: null, mtimeMs }; }
}

/** One usage API call. Never retries. Error snapshots carry retryAfterMs on 429. */
async function fetchClaudeApi(auth, deps = {}) {
  const { AbortSignal } = globalThis;
  if (typeof auth.token !== 'string' || !TOKEN_RE.test(auth.token)) {
    return errorSnapshot('claude', 'NO_AUTH', 'Claude sign-in needed: no usable saved login in this profile');
  }
  const fetchImpl = deps.fetchImpl || fetch;
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(deps.usageUrl || USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': USER_AGENT,
      },
      signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
    });
  } catch {
    // Transport errors from an authenticated request can echo request headers:
    // never copy their text anywhere.
    return errorSnapshot('claude', 'NETWORK', 'Claude usage API unreachable');
  }
  const now = deps.now ? deps.now() : Date.now();
  if (res.status === 401 || res.status === 403) {
    return errorSnapshot('claude', 'NO_AUTH', 'Claude sign-in needed: the usage API rejected the saved login');
  }
  if (res.status === 429) {
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    const snap = errorSnapshot('claude', 'HTTP_429', 'Claude usage API rate limited');
    return { ...snap, retryAfterMs: parseRetryAfter(header, now) };
  }
  if (!res.ok) return errorSnapshot('claude', `HTTP_${res.status}`, `Claude usage API returned ${res.status}`);
  let body;
  try { body = await res.json(); } catch { return errorSnapshot('claude', 'INVALID', 'Claude usage API returned malformed JSON'); }
  return normalizeClaudeApiUsage(body, auth, now);
}

function readLocalClaude(deps, now) {
  let data;
  try { data = JSON.parse((deps.readFileSync || fs.readFileSync)(deps.usagePath || usagePath(deps.configDir), 'utf8')); }
  catch { return errorSnapshot('claude', 'NO_DATA', 'Enable local capture in Settings, then use Claude Code to collect usage.'); }
  return normalizeClaudeUsage(data, now);
}

/** Run the API top-up if the budget allows. Returns an ok snapshot, or an
 * error snapshot describing why there is no new API reading. Waiting states
 * carry error.retryAt (wall clock) so the caller can schedule the next try. */
async function topUpFromApi(deps, localAt) {
  const budget = deps.budget;
  const id = deps.profileId || 'claude';
  const auth = readClaudeAuth(deps);
  if (!auth || !auth.token) return errorSnapshot('claude', 'NO_AUTH', 'Claude sign-in needed: no saved login in this profile');
  const state = { credMtimeMs: auth.mtimeMs, localAt };
  const withRetry = (snap, retryAt) => (Number.isFinite(retryAt) ? { ...snap, error: { ...snap.error, retryAt } } : snap);
  const verdict = budget.check(id, state);
  if (!verdict.ok) {
    if (verdict.reason === 'auth') return errorSnapshot('claude', 'NO_AUTH', 'Claude sign-in needed: sign in to Claude Code again');
    if (verdict.reason === 'suspended') {
      return withRetry(errorSnapshot('claude', 'SUSPENDED', 'Claude usage API top-up is paused: its rate budget is not safely saved'), verdict.retryAt);
    }
    if (verdict.reason === 'cooldown') return withRetry(errorSnapshot('claude', 'HTTP_429', 'Claude usage API rate limited'), verdict.retryAt);
    return withRetry(errorSnapshot('claude', 'QUEUED', 'Claude usage API check is waiting for its turn'), verdict.retryAt);
  }
  if (!budget.begin(id)) {
    return errorSnapshot('claude', 'SUSPENDED', 'Claude usage API top-up is paused: its rate budget is not safely saved');
  }
  const snap = await fetchClaudeApi(auth, deps);
  if (snap.ok) budget.success(id);
  else if (snap.error.code === 'HTTP_429') {
    return withRetry(snap, budget.rateLimited(id, snap.retryAfterMs));
  } else if (snap.error.code === 'NO_AUTH') budget.authFailed(id, state);
  return snap;
}

/** `deps`: { configDir, profileId, apiTopUp, budget, previous (last stored reading),
 * fetchImpl, now, signal, readFileSync, credentialFs, usagePath }. Session and
 * weekly each take the newest observation across local capture, the previous
 * reading, and a fresh API reading. A failed API call never replaces a good
 * reading, but leaves it marked stale until a newer observation arrives. */
async function fetchClaudeQuotas(deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const local = readLocalClaude(deps, now);
  const previous = deps.previous && deps.previous.ok ? deps.previous : null;
  let best = mergeClaudeReadings([previous, local]);
  const needsTopUp = !best || now - best.fetchedAt > API_TOPUP_AFTER_MS
    || best.windows.some((w) => Date.parse(w.resetsAt) <= now);
  let apiError = null;
  if (deps.apiTopUp && deps.budget && needsTopUp) {
    const api = await topUpFromApi(deps, local.ok ? local.fetchedAt : 0);
    if (api.ok) best = mergeClaudeReadings([best, api]);
    else apiError = api;
  }
  if (!best) return apiError || local;
  const failure = apiError && apiError.error.code !== 'QUEUED' ? apiError.error
    : deps.apiTopUp && best === previous && previous.lastError ? previous.lastError : null; // unresolved earlier failure
  const rest = { ...best };
  delete rest.lastError; // from an earlier failed attempt
  delete rest.topUpRetryAt;
  const retryAt = apiError && Number.isFinite(apiError.error.retryAt) ? apiError.error.retryAt : null;
  return { ...rest, stale: !!failure || now - best.fetchedAt > staleLimit(best),
    ...(failure ? { lastError: failure } : {}), ...(retryAt ? { topUpRetryAt: retryAt } : {}) };
}

module.exports = {
  fetchClaudeQuotas, fetchClaudeApi, normalizeClaudeUsage, normalizeClaudeApiUsage, readClaudeAuth,
  LOCAL_STALE_MS, API_STALE_MS, API_TOPUP_AFTER_MS,
};
