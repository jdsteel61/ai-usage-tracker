'use strict';

/**
 * Z.ai adapter (GLM Coding Plan).
 *
 * Queries the read-only quota endpoint with the user's API key:
 *   GET {base}/api/monitor/usage/quota/limit   (default base: https://api.z.ai)
 *
 * The key is NEVER stored by this module. The caller injects a `getKey`
 * accessor (the app wires it to Windows Credential Manager). Classification
 * of limit entries follows the public Coding Plan schema:
 *   data.limits[]: { type: 'TOKENS_LIMIT'|'TIME_LIMIT', unit, number,
 *                    percentage, nextResetTime (epoch ms), ... }
 *   unit codes: 3 = hours, 4 = days, 5 = 30-day months, 6 = weeks.
 * Windows shorter than 24h are the session window; >= 24h are weekly/period.
 */
const { clampPercent, okSnapshot, errorSnapshot } = require('./model');

const DEFAULT_BASE_URL = 'https://api.z.ai';
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const MONTH_SECONDS = 30 * 24 * 3600;

const UNIT_SECONDS = {
  3: 3600,
  4: 24 * 3600,
  5: MONTH_SECONDS,
  6: 7 * 24 * 3600,
};

function msToIso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Duration in seconds for a limit entry, or null for unknown unit codes. */
function limitPeriodSeconds(entry) {
  const unit = Number(entry.unit);
  const count = Number(entry.number);
  if (!UNIT_SECONDS[unit] || !Number.isFinite(count) || count <= 0) return null;
  return Math.round(UNIT_SECONDS[unit] * count);
}

const TOKEN_LIMIT_TYPES = new Set(['TOKENS_LIMIT', 'CREDIT_LIMIT']);

function matchesType(entry, expected) {
  if (entry.type === expected || entry.name === expected) return true;
  // Credit plans renamed TOKENS_LIMIT -> CREDIT_LIMIT with identical layout.
  return expected === 'TOKENS_LIMIT' && TOKEN_LIMIT_TYPES.has(entry.type || entry.name || '');
}

/**
 * Normalize the quota payload into semantic windows. Pure; tested against
 * fixtures. Unknown limit types/units are ignored (never guessed).
 */
function normalizeZaiQuota(body) {
  const root = body && typeof body === 'object' ? body : null;
  if (!root) throw new Error('invalid payload');

  // Explicit "no coding plan" envelope: { success: false, msg: ... coding plan ... }
  if (root.success === false && typeof root.msg === 'string' && /coding plan/i.test(root.msg)) {
    const snap = okSnapshot('zai', { windows: [] });
    snap.notes.push('No Z.ai Coding Plan on this account');
    return snap;
  }

  const container = root.data && typeof root.data === 'object' ? root.data : root;
  const limitsRaw = container.limits;
  if (!Array.isArray(limitsRaw)) throw new Error('invalid payload');

  let session = null;
  let weekly = null;
  const others = [];

  for (const entry of limitsRaw) {
    if (!entry || typeof entry !== 'object') continue;
    if (matchesType(entry, 'TOKENS_LIMIT')) {
      const periodSeconds = limitPeriodSeconds(entry);
      if (periodSeconds === null) continue; // unknown unit: ignore, don't guess
      const percent = clampPercent(entry.percentage);
      const window = {
        id: periodSeconds < 24 * 3600 ? 'zai:session' : 'zai:weekly',
        kind: periodSeconds < 24 * 3600 ? 'session' : 'weekly',
        label: periodSeconds < 24 * 3600 ? '5 hr' : 'Week',
        usedPercent: percent,
        resetsAt: msToIso(Number(entry.nextResetTime)),
        periodSeconds,
      };
      if (window.kind === 'session' && !session) session = window;
      else if (window.kind === 'weekly' && !weekly) weekly = window;
      else others.push(window); // duplicate window kinds kept as 'other'
    } else if (matchesType(entry, 'TIME_LIMIT')) {
      // Web-search allowance: currentValue / usage (limit) counts.
      const used = Number(entry.currentValue);
      const limit = Number(entry.usage);
      if (Number.isFinite(used) && Number.isFinite(limit) && limit >= 0) {
        others.push({
          id: 'zai:webSearches',
          kind: 'other',
          label: 'Web searches',
          usedPercent: limit > 0 ? clampPercent((used / limit) * 100) : 0,
          resetsAt: msToIso(Number(entry.nextResetTime)),
          periodSeconds: limitPeriodSeconds(entry) || MONTH_SECONDS,
          usedValue: used,
          limitValue: limit,
        });
      }
    }
  }

  const windows = [session, weekly].filter(Boolean).concat(others);
  const level = typeof container.level === 'string' && container.level ? container.level : null;
  const snap = okSnapshot('zai', { plan: level, windows });
  if (!session && !weekly) {
    // Sanitized descriptors (enum type + unit code only; no payload values)
    // so the UI and log can explain WHY nothing was recognized.
    const descriptors = limitsRaw
      .filter((e) => e && typeof e === 'object')
      .map((e) => `${e.type || e.name || '?'}(unit=${e.unit}x${e.number})`)
      .join(', ');
    snap.notes.push(`Quota endpoint returned no recognizable session/weekly limit${descriptors ? `: ${descriptors}` : ' (empty limits list)'}`);
  }
  return snap;
}

/**
 * Transport. `deps`: { fetchImpl, getKey, baseUrl }.
 * `getKey` must return the secret string or null (never logged).
 */
async function fetchZaiQuotas(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const baseUrl = (deps.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = typeof deps.getKey === 'function' ? await deps.getKey() : null;
  if (!key) return errorSnapshot('zai', 'NO_KEY', 'No Z.ai API key stored (add it in Settings)');

  let res;
  try {
    res = await fetchImpl(`${baseUrl}${QUOTA_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  } catch (cause) {
    return errorSnapshot('zai', 'NETWORK', `Z.ai endpoint unreachable: ${cause.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    return errorSnapshot('zai', 'NO_AUTH', 'Z.ai API key rejected (401/403)');
  }
  if (res.status === 429) {
    return errorSnapshot('zai', 'HTTP_429', 'Z.ai endpoint rate limited');
  }
  if (!res.ok) {
    return errorSnapshot('zai', `HTTP_${res.status}`, `Z.ai endpoint returned ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return errorSnapshot('zai', 'INVALID', 'Z.ai endpoint returned malformed JSON');
  }
  if (body && typeof body.code === 'number' && body.code !== 200) {
    return errorSnapshot('zai', `API_${body.code}`, `Z.ai: ${body.msg || 'error ' + body.code}`);
  }
  try {
    return normalizeZaiQuota(body);
  } catch {
    return errorSnapshot('zai', 'INVALID', 'Z.ai payload missing limits');
  }
}

module.exports = { fetchZaiQuotas, normalizeZaiQuota, limitPeriodSeconds, DEFAULT_BASE_URL };
