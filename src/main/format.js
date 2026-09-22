'use strict';

/**
 * Reset-countdown and clock formatting. Pure functions of (instant, options)
 * so they are trivially testable, including across DST boundaries.
 */
const MINUTE = 60_000;

/**
 * Human countdown until `resetsAt`. Examples: '38m', '2h 05m', '4d 3h'.
 * Returns null when the value is missing/unusable (UI renders '—').
 */
function formatCountdown(resetsAt, now = Date.now()) {
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return null;
  let ms = t - now;
  if (ms < 0) ms = 0;
  if (ms < MINUTE) return '<1m';
  const totalMinutes = Math.floor(ms / MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Wall-clock rendering of a timestamp, honoring the 12/24-hour setting.
 * `timeZone` is an IANA name (default: system). Uses Intl so DST transitions
 * in the target zone are handled by the platform database.
 */
function formatClock(iso, { hour24 = true, timeZone } = {}) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const options = {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  };
  if (hour24) {
    options.hourCycle = 'h23';
  } else {
    options.hour12 = true;
  }
  return new Intl.DateTimeFormat('en-US', options).format(t);
}

/**
 * Full date+clock rendering, used in tooltips around reset boundaries.
 * Includes the zone abbreviation so a repeated wall-clock hour during a
 * DST fall-back stays unambiguous.
 */
function formatDateTime(iso, { hour24 = true, timeZone } = {}) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const options = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  };
  if (hour24) options.hourCycle = 'h23';
  else options.hour12 = true;
  return new Intl.DateTimeFormat('en-US', options).format(t);
}

/**
 * Age label for stale cached values: 'just now', '12m old', '3h old'.
 */
function formatAge(fetchedAt, now = Date.now()) {
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
  const ms = Math.max(0, now - fetchedAt);
  if (ms < MINUTE) return 'just now';
  const totalMinutes = Math.floor(ms / MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m old`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

module.exports = { formatCountdown, formatClock, formatDateTime, formatAge };
