'use strict';

/**
 * Builds a compact plain-text usage summary for clipboard sharing, e.g. so
 * an agent can factor quota headroom into model routing. Pure and
 * unit-tested; the renderer passes the latest shaped snapshot.
 *
 * Shape (one line per enabled provider):
 *   AI usage - 2026-09-22 08:35
 *   Claude (max): 5h 6% (resets 12:40); week 78% (resets Thu 15:00)
 *   Codex: week 34% (resets Mon 15:00)
 *   OpenRouter: credits 63% (does not reset)
 *   Gemini (AI Studio): no usage API; key valid
 *   Grok: unavailable (NO_KEY)
 */
(function (global) {
  function timeLabel(date, hour24) {
    const fmt = new Intl.DateTimeFormat('en-US', hour24
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { hour: '2-digit', minute: '2-digit', hour12: true });
    return fmt.format(date);
  }

  /** "12:40" when <24h away in either direction, "Thu 15:00" when further. */
  function resetLabel(resetsAt, now, hour24) {
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    if (Math.abs(t - now) < 24 * 3600 * 1000) return timeLabel(d, hour24);
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
    return `${day} ${timeLabel(d, hour24)}`;
  }

  function windowLine(w, now, hour24) {
    if (!w || !Number.isFinite(w.usedPercent)) return null;
    if (Date.parse(w.resetsAt) <= now) {
      return `${w.label || '?'} current usage unknown (last window ${Math.round(w.usedPercent)}%; reset passed ${resetLabel(w.resetsAt, now, hour24)})`;
    }
    let s = `${w.label || '?'} ${Math.round(w.usedPercent)}%`;
    if (w.resetsAt === null || w.resetsAt === undefined) s += ' (does not reset)';
    else {
      const r = resetLabel(w.resetsAt, now, hour24);
      if (r) s += Date.parse(w.resetsAt) <= now ? ` (reset passed ${r})` : ` (resets ${r})`;
    }
    return s;
  }

  /** Claude model-specific weekly limits (API top-up only), plain text, live ones only. */
  function modelLimits(p, now) {
    return (Array.isArray(p.extras) ? p.extras : []).filter((w) => w && typeof w.id === 'string'
      && w.id.startsWith('claude:model:') && Number.isFinite(w.usedPercent) && !(Date.parse(w.resetsAt) <= now))
      .map((w) => ({ name: String(w.label || '').replace(/[^\p{L}\p{N} .\-_+()]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
        w })).filter((m) => m.name);
  }

  function readingAge(fetchedAt, now) {
    if (!Number.isFinite(fetchedAt)) return null;
    const minutes = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m old`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''} old`;
    return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''} old`;
  }

  /** Reading state at display time, including time spent asleep or idle. */
  function isClaudeApi(p) {
    return p.source === 'claude-api' || (p.notes || []).includes('From Claude usage API');
  }

  /** Short card line: source and age, e.g. 'local \u00b7 live' or 'api \u00b7 12 min ago'. */
  function sourceLabel(p, now = Date.now()) {
    const api = isClaudeApi(p);
    const claude = api || p.id === 'claude' || (p.id || '').startsWith('claude-profile-')
      || !!p.source?.startsWith('claude-') || (p.notes || []).includes('From Claude Code status line');
    const minutes = Number.isFinite(p.fetchedAt) ? Math.floor(Math.max(0, now - p.fetchedAt) / 60_000) : null;
    // Only Claude has distinct local/API sources; other providers show age alone.
    const prefix = claude ? `${api ? 'api' : 'local'} \u00b7 ` : '';
    if (minutes === null) return claude ? (api ? 'api' : 'local') : '';
    const age = minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
    if (!api && minutes < 2) return `${prefix}live`;
    return `${prefix}${age}`;
  }

  function apiFailureLabel(p) {
    const error = p.error || p.lastError;
    if (!error || !(p.id === 'claude' || (p.id || '').startsWith('claude-profile-') || p.source?.startsWith('claude-'))) return '';
    if (error.code === 'NO_AUTH') return 'API login rejected';
    if (error.code === 'HTTP_429' || error.code === 'RATE_LIMITED') return 'API rate limited';
    if (error.code === 'SUSPENDED') return 'API checks paused';
    if (error.code === 'NETWORK') return 'API unreachable';
    if (/^HTTP_/.test(error.code)) return `API error ${error.code.slice(5)}`;
    return '';
  }

  function accountDetail(p) {
    const account = p.account;
    if (!account) return '';
    const identity = account.identity;
    return [
      identity ? `Account: ${identity.email || identity.accountId} (${identity.source === 'api' ? 'API verified this session' : 'saved identity; not API verified'})` : 'Account: identity unknown',
      identity?.organizationId ? `Subscription/organization: ${identity.organizationId}` : '',
      account.machine ? `Tracker machine: ${account.machine}` : '',
      account.configDir ? `Local Claude profile: ${account.configDir}` : '',
      `API top-up: ${account.apiEnabled ? 'enabled; includes account usage from other machines' : 'disabled'}`,
      account.verificationError?.message || '',
      p.accountWarning || '',
    ].filter(Boolean).join('\n');
  }

  function readingStatus(p, { now = Date.now(), intervalMinutes = 5, hour24 = true } = {}) {
    const api = isClaudeApi(p) || (!p.ok && !!p.account?.apiEnabled);
    const local = !api && (p.source === 'claude-statusline' || (p.notes || []).includes('From Claude Code status line')
      || p.id === 'claude' || (p.id || '').startsWith('claude-profile-'));
    const age = p.ok ? readingAge(p.fetchedAt, now) : null;
    const limit = (api ? 35 : local ? 15 : 2 * intervalMinutes) * 60_000;
    const expired = Object.values(p.windows || {}).some((w) => w && Date.parse(w.resetsAt) <= now);
    const failure = apiFailureLabel(p);
    const stale = p.stale || !!failure || (p.ok && Number.isFinite(p.fetchedAt) && now - p.fetchedAt > limit) || expired;
    const state = !p.ok ? 'waiting' : stale ? 'cached' : 'current';
    const lines = [
      state === 'cached' ? 'Cached: showing the last saved reading'
        : state === 'waiting' ? 'Waiting: no successful reading yet'
          : api ? 'Current: recent usage from the Claude usage API'
            : local ? 'Current: recent usage captured from Claude Code' : 'Current: last provider check succeeded',
      api ? 'Source: Claude usage API (opt-in top-up; used when local capture is over 25 minutes old)'
        : local ? 'Source: local Claude Code status line; use Claude Code to update' : 'Source: provider metadata check',
      age ? `Reading age: ${age}` : '',
      p.ok && Number.isFinite(p.fetchedAt) ? `Observed: ${new Date(p.fetchedAt).toLocaleString('en-US', { hour12: !hour24 })}` : '',
      expired ? 'Reset passed: the displayed percentage belongs to the previous window' : '',
      expired ? 'Current usage is unknown until a new reading arrives; the old percentage is historical only' : '',
      accountDetail(p),
      ...(modelLimits(p, now).length ? ['Model weekly limits:', ...modelLimits(p, now).map(({ name, w }) => {
        const r = resetLabel(w.resetsAt, now, hour24);
        return `  ${name} ${Math.round(w.usedPercent)}% used${r ? ` (resets ${r})` : ''}`;
      })] : []),
      p.error?.message || (state === 'cached' ? p.lastError?.message : '') || '',
      Number.isFinite(p.error?.retryAt) && p.error.retryAt > now
        ? `Rate limited; next retry ${resetLabel(new Date(p.error.retryAt).toISOString(), now, hour24)}. Refresh respects this pause.` : '',
    ].filter(Boolean);
    return { state, label: failure === 'API login rejected' ? 'login rejected' : failure === 'API rate limited' ? 'rate limited'
      : p.accountWarning ? 'account warning' : state, detail: lines.join('\n') };
  }

  function freshnessLabel(p, now, hour24, intervalMinutes) {
    const labels = [];
    const error = p.error || p.lastError || {};
    const status = readingStatus(p, { now, hour24, intervalMinutes });
    if (status.state === 'cached') labels.push('stale');
    if (isClaudeApi(p)) labels.push('Claude usage API reading');
    else if (p.source === 'claude-statusline' || (p.notes || []).includes('From Claude Code status line')) labels.push('local Claude Code reading');
    if (p.ok) {
      const age = readingAge(p.fetchedAt, now);
      if (age) labels.push(`reading ${age}`);
    }
    const failure = apiFailureLabel(p);
    if (failure) labels.push(failure);
    if (p.accountWarning) labels.push(p.accountWarning);
    if (Number.isFinite(error.retryAt) && error.retryAt > now) {
      labels.push(`cooldown; next retry ${resetLabel(new Date(error.retryAt).toISOString(), now, hour24)}`);
    }
    return labels.length ? ` [${labels.join('; ')}]` : '';
  }

  function providerLine(p, now, hour24, intervalMinutes) {
    const name = p.plan ? `${p.title} (${p.plan})` : p.title;
    if (!p.ok) {
      return `${p.title}: unavailable${p.error && p.error.code ? ` (${p.error.code})` : ''}${freshnessLabel(p, now, hour24, intervalMinutes)}`;
    }
    const parts = [];
    for (const kind of ['session', 'weekly']) {
      const line = p.windows && windowLine(p.windows[kind], now, hour24);
      if (line) parts.push(line);
    }
    for (const { name, w } of modelLimits(p, now)) parts.push(`${name} week ${Math.round(w.usedPercent)}%`);
    if (!parts.length) {
      for (const note of p.notes || []) parts.push(note);
      if (!parts.length) parts.push('no quota windows reported');
    }
    let s = `${name}: ${parts.join('; ')}`;
    if (p.peak) s += p.peak.mode === 'peak' ? ' [peak]' : ' [off-peak: 50% credit]';
    s += freshnessLabel(p, now, hour24, intervalMinutes);
    return s;
  }

  function buildUsageSummary(snap, opts) {
    if (!snap || !Array.isArray(snap.providers)) return '';
    const hour24 = !opts || opts.hour24 !== false;
    const now = (opts && Number.isFinite(opts.now)) ? opts.now : snap.now || Date.now();
    const stamp = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit', ...{},
      ...(hour24 ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: '2-digit', minute: '2-digit', hour12: true }),
    }).format(new Date(now));
    const lines = [`AI usage - ${stamp}`];
    for (const p of snap.providers) {
      if (!p || p.enabled === false) continue;
      lines.push(providerLine(p, now, hour24, opts?.intervalMinutes));
    }
    return lines.join('\n');
  }

  const api = { buildUsageSummary, resetLabel, readingStatus, sourceLabel, accountDetail };
  global.AITRACKER_SUMMARY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
