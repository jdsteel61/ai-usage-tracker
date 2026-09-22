'use strict';

/**
 * Zoom-to-fit math for the renderer. Pure and unit-tested; the renderer
 * measures the unzoomed content size and passes it in.
 *
 * The panel always shows every enabled provider: if the window is too
 * small, everything scales down (min clamp); if the user drags it larger,
 * everything scales up (max clamp). Width and height both constrain.
 */
(function (global) {
  /**
   * Largest scale in [min, max] at which a needW x needH layout fits into
   * availW x availH. Returns 1 (no scaling) for invalid inputs.
   */
  function computeFitScale(availW, availH, needW, needH, opts) {
    const min = opts && Number.isFinite(opts.min) ? opts.min : 0.5;
    const max = opts && Number.isFinite(opts.max) ? opts.max : 1.8;
    if (![availW, availH, needW, needH].every((n) => Number.isFinite(n) && n > 0)) return 1;
    const s = Math.min(availW / needW, availH / needH);
    return Math.min(max, Math.max(min, s));
  }

  const api = { computeFitScale };
  global.AITRACKER_SCALE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
