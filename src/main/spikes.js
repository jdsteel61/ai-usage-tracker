'use strict';

/**
 * Spike detection.
 *
 * History holds ONLY normalized samples per (provider, window):
 *   { t, percent, resetsAt, state: 'ok' | 'error' }
 * No prompts, responses, paths, session contents, credentials, or raw
 * provider payloads are ever stored.
 *
 * A spike is flagged for a window when EITHER:
 *  - usage rises >= spikeAbsolutePoints within one normal polling interval
 *    (deltas are normalized to the actual time between samples), OR
 *  - usage rises >= spikeRelativePoints AND the normalized rate exceeds
 *    spikeRelativeMultiplier x that window's rolling median rate over the
 *    previous 24 hours.
 *
 * Never flagged: the first sample, a quota reset (usage drop or changed
 * reset timestamp), recovery from a stale/error state, or a gap longer than
 * three normal polling intervals.
 */

const HOUR = 3600_000;

/**
 * Compute rates (points/hour) between consecutive usable sample pairs in the
 * previous 24h. Pairs spanning resets, errors, or long gaps are excluded so
 * they cannot pollute the baseline.
 */
function baselineRates(history, intervalMs, now, { relativeWindowMs = 24 * HOUR } = {}) {
  const usable = history.filter((s) => Number.isFinite(s.percent) && s.state === 'ok');
  const rates = [];
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1];
    const b = usable[i];
    if (now - b.t > relativeWindowMs) continue; // outside the rolling window
    const gap = b.t - a.t;
    if (gap <= 0 || gap > 3 * intervalMs) continue; // reset/long gap guard for baseline too
    if (b.percent < a.percent) continue; // reset
    if (a.resetsAt !== b.resetsAt) continue; // window rolled over
    const hours = gap / HOUR;
    if (hours > 0) rates.push((b.percent - a.percent) / hours);
  }
  return rates;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Evaluate the newest sample of `history` (sorted ascending by t) for spikes.
 * `opts`: { intervalMinutes, absolutePoints, relativePoints, relativeMultiplier }.
 * Returns null or an alert:
 *   { providerId, windowId, kind: 'absolute'|'relative', deltaPoints, fromT, toT }
 */
function detectSpike(providerId, windowId, history, opts = {}, now = Date.now()) {
  const intervalMs = Math.max(60_000, (opts.intervalMinutes || 5) * 60_000);
  const absolutePoints = opts.absolutePoints === undefined ? 8 : opts.absolutePoints;
  const relativePoints = opts.relativePoints === undefined ? 3 : opts.relativePoints;
  const relativeMultiplier = opts.relativeMultiplier === undefined ? 4 : opts.relativeMultiplier;

  if (!Array.isArray(history) || history.length < 2) return null; // first sample: never flag
  const prev = history[history.length - 2];
  const cur = history[history.length - 1];

  if (prev.state !== 'ok' || cur.state !== 'ok') return null; // stale/error recovery: never flag
  if (!Number.isFinite(prev.percent) || !Number.isFinite(cur.percent)) return null;

  const gap = cur.t - prev.t;
  if (gap <= 0) return null;
  if (gap > 3 * intervalMs) return null; // long gap: baseline is meaningless
  if (cur.percent < prev.percent) return null; // usage dropped: quota reset
  if (prev.resetsAt !== cur.resetsAt) return null; // window rolled over: reset

  const delta = cur.percent - prev.percent;
  if (delta <= 0) return null; // flat or zero growth

  // Normalize to one polling interval: what would this delta amount to at the
  // normal cadence? (gap == intervalMs -> factor 1; longer gaps scale down.)
  const normalizedDelta = delta * (intervalMs / gap);
  if (normalizedDelta >= absolutePoints) {
    return { providerId, windowId, kind: 'absolute', deltaPoints: Math.round(delta * 10) / 10, fromT: prev.t, toT: cur.t };
  }

  if (delta >= relativePoints || normalizedDelta >= relativePoints) {
    const rates = baselineRates(history.slice(0, -1), intervalMs, now);
    const med = median(rates);
    if (med !== null && med > 0) {
      const currentRate = delta / (gap / HOUR); // points/hour
      if (currentRate > relativeMultiplier * med) {
        return { providerId, windowId, kind: 'relative', deltaPoints: Math.round(delta * 10) / 10, fromT: prev.t, toT: cur.t };
      }
    }
  }
  return null;
}

/**
 * Active alert bookkeeping: an alert stays visible for `alertMinutes`.
 * `activeAlerts` is a map `${providerId}:${windowId}` -> { alert, until }.
 * Returns a NEW map (pure) with expiries pruned and the new alert applied.
 */
function applyAlert(activeAlerts, alert, alertMinutes = 30, now = Date.now()) {
  const next = {};
  for (const [k, v] of Object.entries(activeAlerts || {})) {
    if (v.until > now) next[k] = v;
  }
  if (alert) {
    next[`${alert.providerId}:${alert.windowId}`] = { alert, until: now + alertMinutes * 60_000 };
  }
  return next;
}

/** Provider-level '!' is visible when any window alert is active. */
function providerHasSpike(activeAlerts, providerId, now = Date.now()) {
  return Object.entries(activeAlerts || {}).some(
    ([k, v]) => k.startsWith(`${providerId}:`) && v.until > now,
  );
}

/** Human explanation used for the '!' tooltip/click text. */
function describeAlert(alert, clockFormatter) {
  const fmt = clockFormatter || ((t) => {
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const label = String(alert.providerId).replace(/^\w/, (c) => c.toUpperCase());
  const windowText = alert.windowId.includes('session') ? '5h' : 'weekly';
  return `${label} ${windowText} increased ${alert.deltaPoints}% between ${fmt(alert.fromT)} and ${fmt(alert.toT)}`;
}

module.exports = { detectSpike, applyAlert, providerHasSpike, describeAlert, baselineRates, median };
