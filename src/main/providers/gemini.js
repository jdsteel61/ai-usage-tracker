'use strict';

/**
 * Gemini (Google AI Studio) adapter.
 *
 * Google does not expose usage/quota for AI Studio keys over the API, so
 * this adapter validates the key against the free models-list metadata
 * endpoint (no inference, no cost):
 *   GET {base}/v1beta/models   (key via x-goog-api-key header - never in a URL)
 * and reports key health plus the documented free-tier limits as notes.
 * The key is NEVER stored here; the caller injects `getKey` (wired to
 * Windows Credential Manager).
 */
const { okSnapshot, errorSnapshot } = require('./model');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const MODELS_PATH = '/v1beta/models';

/** Pure mapping for tests. */
function normalizeGeminiKeyCheck(body) {
  const root = body && typeof body === 'object' ? body : null;
  if (!root) throw new Error('invalid payload');
  const count = Array.isArray(root.models) ? root.models.length : 0;
  const snap = okSnapshot('gemini', {
    plan: 'AI Studio',
    windows: [], // Google exposes no usage/quota API for these keys
  });
  snap.notes.push('Key valid - Google exposes no usage/quota API');
  snap.notes.push('Free tier: 15 RPM / 1,500 RPD (docs)');
  if (!count) snap.notes.push('Models list empty for this key');
  return snap;
}

/** Transport. `deps`: { fetchImpl, getKey, baseUrl }. */
async function fetchGeminiQuotas(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const baseUrl = (deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = typeof deps.getKey === 'function' ? await deps.getKey() : null;
  if (!key) return errorSnapshot('gemini', 'NO_KEY', 'No Gemini API key stored (add it in Settings)');

  let res;
  try {
    res = await fetchImpl(`${baseUrl}${MODELS_PATH}?pageSize=1`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-goog-api-key': key },
    });
  } catch (cause) {
    return errorSnapshot('gemini', 'NETWORK', `Gemini endpoint unreachable: ${cause.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    return errorSnapshot('gemini', 'NO_AUTH', 'Gemini API key rejected (401/403)');
  }
  if (res.status === 429) {
    return errorSnapshot('gemini', 'HTTP_429', 'Gemini endpoint rate limited');
  }
  if (!res.ok) {
    return errorSnapshot('gemini', `HTTP_${res.status}`, `Gemini endpoint returned ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return errorSnapshot('gemini', 'INVALID', 'Gemini endpoint returned malformed JSON');
  }
  try {
    return normalizeGeminiKeyCheck(body);
  } catch {
    return errorSnapshot('gemini', 'INVALID', 'Gemini payload unrecognized');
  }
}

module.exports = { fetchGeminiQuotas, normalizeGeminiKeyCheck, DEFAULT_BASE_URL };
