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

  /** "12:40" when <24h away, "Thu 15:00" when further. */
  function resetLabel(resetsAt, now, hour24) {
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    if (t - now < 24 * 3600 * 1000) return timeLabel(d, hour24);
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
    return `${day} ${timeLabel(d, hour24)}`;
  }

  function windowLine(w, now, hour24) {
    if (!w || !Number.isFinite(w.usedPercent)) return null;
    let s = `${w.label || '?'} ${Math.round(w.usedPercent)}%`;
    if (w.resetsAt === null || w.resetsAt === undefined) s += ' (does not reset)';
    else {
      const r = resetLabel(w.resetsAt, now, hour24);
      if (r) s += ` (resets ${r})`;
    }
    return s;
  }

  function providerLine(p, now, hour24) {
    const name = p.plan ? `${p.title} (${p.plan})` : p.title;
    if (!p.ok) {
      return `${p.title}: unavailable${p.error && p.error.code ? ` (${p.error.code})` : ''}`;
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
    if (p.stale) s += ' [stale]';
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
      lines.push(providerLine(p, now, hour24));
    }
    return lines.join('\n');
  }

  const api = { buildUsageSummary, resetLabel };
  global.AITRACKER_SUMMARY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
