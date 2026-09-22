'use strict';

/**
 * OpenRouter adapter.
 *
 * Two read-only metadata endpoints (both free, no inference):
 *   GET https://openrouter.ai/api/v1/key      -> key info + usage/limit credits
 *   GET https://openrouter.ai/api/v1/credits  -> prepaid credit balance
 *
 * `usage`/`limit` are USD credits. A key with limit > 0 gets a
 * credit-budget window (used%); pay-as-you-go keys fall back to the
 * prepaid /credits balance. Credits do not reset, so resetsAt is null.
 * The key is NEVER stored here; the caller injects `getKey`
 * (wired to Windows Credential Manager).
 */
const { clampPercent, okSnapshot, errorSnapshot } = require('./model');

const DEFAULT_BASE_URL = 'https://openrouter.ai';
const KEY_PATH = '/api/v1/key';
const CREDITS_PATH = '/api/v1/credits';

async function getJson(fetchImpl, url, key) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    return { status: res.status, error: 'NO_AUTH' };
  }
  if (!res.ok) {
    return { status: res.status, error: `HTTP_${res.status}` };
  }
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: res.status, error: 'INVALID' };
  }
}

/** Map {usage, limit, is_free_tier, rate_limit} into a credit window. Pure. */
function normalizeOpenRouter(keyData, creditsData) {
  const d = keyData && typeof keyData === 'object' ? keyData : {};
  const notes = [];
  const rate = d.rate_limit && Number.isFinite(Number(d.rate_limit.requests))
    ? `${d.rate_limit.requests} req/${d.rate_limit.interval || '?'}`
    : null;
  if (rate) notes.push(`Rate limit: ${rate}`);

  let window = null;
  const usage = Number(d.usage);
  const limit = Number(d.limit);
  if (Number.isFinite(usage) && Number.isFinite(limit) && limit > 0) {
    window = {
      id: 'openrouter:budget',
      kind: 'weekly',
      label: 'Credits',
      usedPercent: clampPercent((usage / limit) * 100),
      resetsAt: null, // credit budgets do not reset
      periodSeconds: null,
    };
  } else {
    const c = creditsData && typeof creditsData === 'object' ? creditsData : {};
    const total = Number(c.total_credits);
    const used = Number(c.total_credits_used);
    if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
      window = {
        id: 'openrouter:prepaid',
        kind: 'weekly',
        label: 'Credits',
        usedPercent: clampPercent((used / total) * 100),
        resetsAt: null,
        periodSeconds: null,
      };
      notes.push('Pay-as-you-go credits (no hard limit)');
    } else {
      notes.push('No spendable credit limit reported for this key');
    }
  }

  const snap = okSnapshot('openrouter', {
    plan: d.is_free_tier ? 'free tier' : null,
    windows: window ? [window] : [],
  });
  snap.notes.push(...notes);
  return snap;
}

/** Transport. `deps`: { fetchImpl, getKey, baseUrl }. */
async function fetchOpenRouterQuotas(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const baseUrl = (deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = typeof deps.getKey === 'function' ? await deps.getKey() : null;
  if (!key) return errorSnapshot('openrouter', 'NO_KEY', 'No OpenRouter API key stored (add it in Settings)');

  let keyResp;
  try {
    keyResp = await getJson(fetchImpl, `${baseUrl}${KEY_PATH}`, key);
  } catch (cause) {
    return errorSnapshot('openrouter', 'NETWORK', `OpenRouter endpoint unreachable: ${cause.message}`);
  }
  if (keyResp.error === 'NO_AUTH') return errorSnapshot('openrouter', 'NO_AUTH', 'OpenRouter API key rejected (401/403)');
  if (keyResp.error) return errorSnapshot('openrouter', keyResp.error, `OpenRouter /key returned ${keyResp.status}`);

  let creditsResp = null;
  const keyData = keyResp.body && keyResp.body.data ? keyResp.body.data : keyResp.body;
  const limit = Number(keyData && keyData.limit);
  if (!(Number.isFinite(limit) && limit > 0)) {
    // Pay-as-you-go key: fall back to the prepaid balance endpoint.
    try {
      creditsResp = await getJson(fetchImpl, `${baseUrl}${CREDITS_PATH}`, key);
    } catch {
      creditsResp = null; // balance is optional; key info already succeeded
    }
  }

  const creditsData = creditsResp && creditsResp.body && creditsResp.body.data
    ? creditsResp.body.data
    : (creditsResp && creditsResp.body) || null;
  try {
    return normalizeOpenRouter(keyData, creditsData);
  } catch {
    return errorSnapshot('openrouter', 'INVALID', 'OpenRouter payload unrecognized');
  }
}

module.exports = { fetchOpenRouterQuotas, normalizeOpenRouter, DEFAULT_BASE_URL };
