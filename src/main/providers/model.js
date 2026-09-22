'use strict';

/**
 * Normalized quota window kinds.
 * - 'session'  : the provider's rolling ~5-hour / per-session window
 * - 'weekly'   : the provider's weekly (7-day) window
 * - 'other'    : provider-specific windows (daily, monthly, web searches,
 *                per-model scoped limits, ...). Mini mode does not render
 *                these by default but keeps them for tooltips.
 */
const WINDOW_KINDS = ['session', 'weekly', 'other'];

/**
 * Clamp a raw percentage into [0, 100]. Returns null for unknown/unusable
 * values so the UI can render '—' instead of inventing a number.
 */
function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Successful provider snapshot. */
function okSnapshot(providerId, { plan = null, windows = [], notes = [], fetchedAt = Date.now() } = {}) {
  return {
    providerId,
    ok: true,
    plan,
    windows,
    notes,
    fetchedAt,
  };
}

/** Failed provider snapshot; must never contain credential material. */
function errorSnapshot(providerId, code, message) {
  return {
    providerId,
    ok: false,
    error: { code: String(code), message: String(message).slice(0, 300) },
    fetchedAt: Date.now(),
  };
}

/**
 * Pick a window of a given semantic kind from a snapshot.
 * Never assumes positional ordering.
 */
function findWindow(snapshot, kind) {
  if (!snapshot || !Array.isArray(snapshot.windows)) return undefined;
  return snapshot.windows.find((w) => w && w.kind === kind) || undefined;
}

module.exports = {
  WINDOW_KINDS,
  clampPercent,
  okSnapshot,
  errorSnapshot,
  findWindow,
};
