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
    let s = `${w.label || '?'} ${Math.round(w.usedPercent)}%`;
    if (w.resetsAt === null || w.resetsAt === undefined) s += ' (does not reset)';
    else {
      const r = resetLabel(w.resetsAt, now, hour24);
      if (r) s += Date.parse(w.resetsAt) <= now ? ` (reset passed ${r})` : ` (resets ${r})`;
    }
    return s;
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
    const minutes = Number.isFinite(p.fetchedAt) ? Math.floor(Math.max(0, now - p.fetchedAt) / 60_000) : null;
    if (minutes === null) return api ? 'api' : 'local';
    const age = minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
    if (!api && minutes < 2) return 'local \u00b7 live';
    return `${api ? 'api' : 'local'} \u00b7 ${age}`;
  }

  function readingStatus(p, { now = Date.now(), intervalMinutes = 5, hour24 = true } = {}) {
    const api = isClaudeApi(p);
    const local = !api && (p.source === 'claude-statusline' || (p.notes || []).includes('From Claude Code status line')
      || p.id === 'claude' || (p.id || '').startsWith('claude-profile-'));
    const age = p.ok ? readingAge(p.fetchedAt, now) : null;
    const limit = (api ? 35 : local ? 15 : 2 * intervalMinutes) * 60_000;
    const expired = Object.values(p.windows || {}).some((w) => w && Date.parse(w.resetsAt) <= now);
    const stale = p.stale || (p.ok && Number.isFinite(p.fetchedAt) && now - p.fetchedAt > limit) || expired;
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
      p.error?.message || '',
      Number.isFinite(p.error?.retryAt) && p.error.retryAt > now
        ? `Rate limited; next retry ${resetLabel(new Date(p.error.retryAt).toISOString(), now, hour24)}. Refresh respects this pause.` : '',
    ].filter(Boolean);
    return { state, label: state, detail: lines.join('\n') };
  }

  function freshnessLabel(p, now, hour24, intervalMinutes) {
    const labels = [];
    const error = p.error || {};
    const status = readingStatus(p, { now, hour24, intervalMinutes });
    if (status.state === 'cached') labels.push('stale');
    if (isClaudeApi(p)) labels.push('Claude usage API reading');
    else if (p.source === 'claude-statusline' || (p.notes || []).includes('From Claude Code status line')) labels.push('local Claude Code reading');
    if (p.ok) {
      const age = readingAge(p.fetchedAt, now);
      if (age) labels.push(`reading ${age}`);
    }
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

  const api = { buildUsageSummary, resetLabel, readingStatus, sourceLabel };
  global.AITRACKER_SUMMARY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
