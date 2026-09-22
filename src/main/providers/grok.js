'use strict';

/**
 * Grok (xAI) adapter.
 *
 * xAI exposes key info at GET https://api.x.ai/v1/api-key (Bearer). There
 * is no documented usage/quota endpoint, so this adapter validates the key
 * and maps credit/usage fields IF the response ever carries them (shape is
 * unknown; mapping is defensive and never guesses). Without usable numbers
 * the card reports key health plus a pointer to console.x.ai.
 * The key is NEVER stored here; the caller injects `getKey` (wired to
 * Windows Credential Manager). Metadata only - no inference calls.
 */
const { clampPercent, okSnapshot, errorSnapshot } = require('./model');

const DEFAULT_BASE_URL = 'https://api.x.ai';
const KEY_PATH = '/v1/api-key';

/**
 * Search a shallow object (plus a nested data/error-free level) for a
 * numeric {used, limit} credit pair. Returns a window or null. Pure.
 */
function findCreditPair(data) {
  const containers = [data, data && typeof data.data === 'object' ? data.data : null];
  // Also accept one nested level (e.g. usage: { total_credits_used }) since
  // the real xAI schema is undocumented.
  for (const c of containers) {
    if (c && typeof c === 'object') {
      for (const v of Object.values(c)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) containers.push(v);
      }
    }
  }
  const USED = ['usage', 'used', 'credits_used', 'total_credits_used'];
  const LIMIT = ['limit', 'credits', 'total_credits', 'credit_limit'];
  const pairOf = (c) => {
    if (!c || typeof c !== 'object') return null;
    let used = null;
    let limit = null;
    for (const k of USED) {
      const n = Number(c[k]);
      if (Number.isFinite(n) && n >= 0) { used = n; break; }
    }
    for (const k of LIMIT) {
      const n = Number(c[k]);
      if (Number.isFinite(n) && n > 0) { limit = n; break; }
    }
    return used !== null && limit !== null ? { used, limit } : null;
  };
  // Pass 1: strict - a matching pair on the same object.
  for (const c of containers) {
    const pair = pairOf(c);
    if (pair) {
      return {
        id: 'grok:credits',
        kind: 'weekly',
        label: 'Credits',
        usedPercent: clampPercent((pair.used / pair.limit) * 100),
        resetsAt: null,
        periodSeconds: null,
      };
    }
  }
  // Pass 2: split across levels (usage nested one deeper than the limit).
  let used = null;
  let limit = null;
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    if (used === null) {
      for (const k of USED) {
        const n = Number(c[k]);
        if (Number.isFinite(n) && n >= 0) { used = n; break; }
      }
    }
    if (limit === null) {
      for (const k of LIMIT) {
        const n = Number(c[k]);
        if (Number.isFinite(n) && n > 0) { limit = n; break; }
      }
    }
  }
  if (used !== null && limit !== null) {
    return {
      id: 'grok:credits',
      kind: 'weekly',
      label: 'Credits',
      usedPercent: clampPercent((used / limit) * 100),
      resetsAt: null,
      periodSeconds: null,
    };
  }
  return null;
}

/** Pure mapping for tests. */
function normalizeGrokKeyInfo(body) {
  const root = body && typeof body === 'object' ? body : null;
  if (!root) throw new Error('invalid payload');
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  const window = findCreditPair(data);
  const snap = okSnapshot('grok', { windows: window ? [window] : [] });
  if (window) {
    snap.notes.push('Credit balance (does not reset)');
  } else {
    snap.notes.push('Key valid');
    snap.notes.push('xAI exposes no usage/quota API yet - see console.x.ai');
  }
  return snap;
}

/** Transport. `deps`: { fetchImpl, getKey, baseUrl }. */
async function fetchGrokQuotas(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const baseUrl = (deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = typeof deps.getKey === 'function' ? await deps.getKey() : null;
  if (!key) return errorSnapshot('grok', 'NO_KEY', 'No Grok (xAI) API key stored (add it in Settings)');

  let res;
  try {
    res = await fetchImpl(`${baseUrl}${KEY_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  } catch (cause) {
    return errorSnapshot('grok', 'NETWORK', `xAI endpoint unreachable: ${cause.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    return errorSnapshot('grok', 'NO_AUTH', 'Grok (xAI) API key rejected (401/403)');
  }
  if (!res.ok) {
    return errorSnapshot('grok', `HTTP_${res.status}`, `xAI endpoint returned ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return errorSnapshot('grok', 'INVALID', 'xAI endpoint returned malformed JSON');
  }
  try {
    return normalizeGrokKeyInfo(body);
  } catch {
    return errorSnapshot('grok', 'INVALID', 'xAI payload unrecognized');
  }
}

module.exports = { fetchGrokQuotas, normalizeGrokKeyInfo, findCreditPair, DEFAULT_BASE_URL };
