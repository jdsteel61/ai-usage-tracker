'use strict';

/**
 * Claude Code adapter.
 *
 * Reuses the Claude Code OAuth login by reading the access token from the
 * credentials file Claude Code itself maintains (~/.claude/.credentials.json)
 * and calling the account usage endpoint:
 *   GET https://api.anthropic.com/api/oauth/usage
 *   (anthropic-beta: oauth-2025-04-20)
 *
 * This is a read-only metadata query: no `claude -p` prompt and no Messages
 * API call, so monitoring never consumes model usage. The credential store is
 * never modified; the token is re-read on every poll so we always ride along
 * with whatever token Claude Code keeps fresh.
 *
 * Transport (fetch) and credential-file access are injectable for tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clampPercent, okSnapshot, errorSnapshot } = require('./model');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USER_AGENT = 'ai-usage-tracker/1.0 (claude-code-login-reuse)';

function defaultCredentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/** Read-only credential access; returns null when signed out/unavailable. */
function readClaudeAuth(deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const credPath = deps.credentialsPath || defaultCredentialsPath();
  let raw;
  try {
    raw = readFileSync(credPath, 'utf8');
  } catch {
    return null; // not signed in on this machine
  }
  try {
    const data = JSON.parse(raw);
    const oauth = (data && data.claudeAiOauth) || {};
    if (!oauth.accessToken || typeof oauth.accessToken !== 'string') return null;
    return {
      token: oauth.accessToken,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
    };
  } catch {
    return { corrupt: true };
  }
}

function toIso(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Normalize the usage payload into semantic windows. Pure; tested against
 * fixtures. Shape (representative):
 * { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at },
 *   limits: [ { kind: 'weekly_scoped', scope: { model: {...} }, percent, resets_at } ] }
 */
function normalizeClaudeUsage(data, auth) {
  const windows = [];
  const notes = [];

  const fiveHour = data && data.five_hour;
  if (fiveHour && typeof fiveHour.utilization === 'number') {
    windows.push({
      id: 'claude:session',
      kind: 'session',
      label: '5 hr',
      usedPercent: clampPercent(fiveHour.utilization),
      resetsAt: toIso(fiveHour.resets_at),
      periodSeconds: 5 * 3600,
    });
  }

  const sevenDay = data && data.seven_day;
  if (sevenDay && typeof sevenDay.utilization === 'number') {
    windows.push({
      id: 'claude:weekly',
      kind: 'weekly',
      label: 'Week',
      usedPercent: clampPercent(sevenDay.utilization),
      resetsAt: toIso(sevenDay.resets_at),
      periodSeconds: 7 * 24 * 3600,
    });
  }

  // Optional model-specific limits: normalized but rendered only in tooltips.
  if (Array.isArray(data && data.limits)) {
    for (const lim of data.limits) {
      if (!lim || lim.kind !== 'weekly_scoped') continue;
      const model = lim.scope && lim.scope.model;
      if (!model) continue;
      const name = model.display_name || model.value || model.id || 'model';
      windows.push({
        id: `claude:model:${String(model.id || name)}`,
        kind: 'other',
        label: String(name),
        usedPercent: clampPercent(lim.percent),
        resetsAt: toIso(lim.resets_at),
        periodSeconds: 7 * 24 * 3600,
      });
    }
  }

  if (windows.length === 0) {
    notes.push('No subscription windows returned; usage-based API billing may be in effect');
  }

  return okSnapshot('claude', {
    plan: auth && auth.subscriptionType ? String(auth.subscriptionType) : null,
    windows,
    notes,
  });
}

/**
 * Transport. `deps`: { fetchImpl, readFileSync, credentialsPath, usageUrl }.
 */
async function fetchClaudeQuotas(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const usageUrl = deps.usageUrl || USAGE_URL;
  const auth = readClaudeAuth(deps);
  if (!auth) return errorSnapshot('claude', 'NO_AUTH', 'Claude Code is not signed in on this machine');
  if (auth.corrupt) return errorSnapshot('claude', 'NO_AUTH', 'Claude credentials file is unreadable');

  let res;
  try {
    res = await fetchImpl(usageUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (cause) {
    return errorSnapshot('claude', 'NETWORK', `Usage endpoint unreachable: ${cause.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    return errorSnapshot('claude', 'NO_AUTH', 'Claude login rejected (401/403)');
  }
  if (res.status === 429) {
    return errorSnapshot('claude', 'HTTP_429', 'Usage endpoint rate limited');
  }
  if (!res.ok) {
    return errorSnapshot('claude', `HTTP_${res.status}`, `Usage endpoint returned ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return errorSnapshot('claude', 'INVALID', 'Usage endpoint returned malformed JSON');
  }
  return normalizeClaudeUsage(body, auth);
}

module.exports = { fetchClaudeQuotas, normalizeClaudeUsage, readClaudeAuth, defaultCredentialsPath };
