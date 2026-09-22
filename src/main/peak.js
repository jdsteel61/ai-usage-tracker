'use strict';

/**
 * Z.ai (GLM Coding Plan) peak/off-peak indicator.
 *
 * The quota API does not expose peak state, but Zhipu / BigModel publish
 * the schedule: peak hours are Mon-Fri 14:00-18:00 (UTC+8), and off-peak
 * model calls are charged at 50% of the base credit cost. We compute the
 * state against the Beijing clock regardless of the machine's timezone
 * (Beijing has no DST, so UTC+8 is a fixed offset year-round).
 *
 * Adapted from agent-usage-widget's src/peak.js (MIT, (c) chunnytechmate);
 * see THIRD_PARTY_NOTICES.md.
 */
const OFFSET_MS = 8 * 3600_000;
const WEEKDAYS = new Set([1, 2, 3, 4, 5]); // Mon..Fri (0=Sun..6=Sat)
const START_MIN = 14 * 60; // 14:00 Beijing, inclusive
const END_MIN = 18 * 60; // 18:00 Beijing, exclusive

const PEAK_DESCRIPTION = 'Z.ai peak hours: Mon-Fri 14:00-18:00 Beijing (UTC+8)';
const OFF_PEAK_DESCRIPTION = 'Z.ai off-peak: calls cost 50% credit. Peak hours: Mon-Fri 14:00-18:00 Beijing (UTC+8)';

/** Beijing wall-clock parts for an instant (arithmetic shift, no tz db). */
function beijingParts(ms) {
  const b = new Date(ms + OFFSET_MS);
  return {
    day: b.getUTCDay(),
    minutesOfDay: b.getUTCHours() * 60 + b.getUTCMinutes(),
    y: b.getUTCFullYear(),
    mo: b.getUTCMonth(),
    d: b.getUTCDate(),
  };
}

/** UTC instant for a Beijing wall-clock Y-M-D H:M. */
function beijingInstant(y, mo, d, h, mi) {
  return Date.UTC(y, mo, d, h, mi, 0) - OFFSET_MS;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Peak state for a moment in time. Pure; `now` is epoch ms.
 * Returns { mode: 'peak'|'off-peak', endsAt, nextStartAt, description }.
 */
function getZaiPeakState(now = Date.now()) {
  if (!Number.isFinite(now)) now = Date.now();
  const p = beijingParts(now);
  const inPeak = WEEKDAYS.has(p.day) && p.minutesOfDay >= START_MIN && p.minutesOfDay < END_MIN;
  if (inPeak) {
    return {
      mode: 'peak',
      endsAt: toIso(beijingInstant(p.y, p.mo, p.d, 18, 0)),
      nextStartAt: null,
      description: PEAK_DESCRIPTION,
    };
  }
  // Scan forward (up to a week) for the next Mon-Fri 14:00 strictly after
  // `now` - handles "already past 14:00 today" and weekends.
  for (let add = 0; add <= 7; add++) {
    const ms = beijingInstant(p.y, p.mo, p.d + add, 14, 0);
    // 14:00 Beijing == 06:00 UTC the same calendar day, so the UTC weekday
    // of the instant is the Beijing weekday of the window.
    if (WEEKDAYS.has(new Date(ms).getUTCDay()) && ms > now) {
      return {
        mode: 'off-peak',
        endsAt: null,
        nextStartAt: toIso(ms),
        description: OFF_PEAK_DESCRIPTION,
      };
    }
  }
  return { mode: 'off-peak', endsAt: null, nextStartAt: null, description: OFF_PEAK_DESCRIPTION };
}

module.exports = { getZaiPeakState, PEAK_DESCRIPTION, OFF_PEAK_DESCRIPTION };
