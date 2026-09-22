'use strict';

/**
 * Pure window-state helpers (persisted bounds + work-area clamping), split
 * out of main.js so they are unit-testable without an Electron instance.
 */

const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 216;
const MIN_WIDTH = 250;
const MIN_HEIGHT = 170;
// Previous defaults; saved sizes equal to any of them migrate to the
// current default so existing users get the smaller window once.
const LEGACY_DEFAULTS = [
  { width: 378, height: 378 }, // v1.0.x
  { width: 300, height: 232 }, // v1.1.0
];

/**
 * Clamp saved bounds to a work area so a monitor that disappeared doesn't
 * strand the window off-screen. Falls back to defaults when unusable.
 */
function clampToBounds(saved, workArea) {
  const wa = {
    x: workArea.x, y: workArea.y,
    width: workArea.width, height: workArea.height,
  };
  const isLegacy = saved && LEGACY_DEFAULTS.some(
    (d) => Math.round(saved.width) === d.width && Math.round(saved.height) === d.height,
  );
  if (!saved || isLegacy
      || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)
      || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return { ...defaultPosition(wa) };
  }
  let { x, y } = saved;
  const width = Math.max(MIN_WIDTH, Math.round(saved.width));
  const height = Math.max(MIN_HEIGHT, Math.round(saved.height));
  // Default position when the window is completely outside the work area.
  if (x + width < wa.x + 16 || y + height < wa.y + 16 || x > wa.x + wa.width - 16 || y > wa.y + wa.height - 16) {
    return { ...defaultPosition(wa) };
  }
  // Nudge back inside otherwise.
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function defaultPosition(workArea) {
  return {
    x: workArea.x + workArea.width - DEFAULT_WIDTH - 24,
    y: workArea.y + 24,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

/**
 * Decide the effective launch behavior on second instance: reveal and focus
 * the existing window instead of launching another.
 */
function revealActionFor() {
  return { action: 'show-and-focus' };
}

module.exports = { clampToBounds, defaultPosition, revealActionFor, DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_WIDTH, MIN_HEIGHT, LEGACY_DEFAULTS };
