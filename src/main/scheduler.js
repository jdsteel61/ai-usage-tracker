'use strict';

/**
 * Background poll scheduler.
 * - interval-based with modest jitter (up to +/-10%) so panels of monitors
 *   don't synchronize thundering herds,
 * - manual refresh debounced (2s) and coalesced with the loop,
 * - graceful cancellation: stop() aborts in-flight polls via a generation
 *   counter; late results are discarded.
 */
const JITTER_FRACTION = 0.1;
const DEBOUNCE_MS = 2000;

class Scheduler {
  constructor(runFn, { setIntervalMs, clearTimeoutFn, random = Math.random } = {}) {
    this.runFn = runFn; // async () => void; must never throw
    this.setIntervalMs = setIntervalMs || ((fn, ms) => setInterval(fn, ms));
    this.clearTimeoutFn = clearTimeoutFn || ((t) => clearTimeout(t));
    this.clearIntervalFn = (h) => clearInterval(h);
    this.random = random;

    this.timer = null;
    this.generation = 0; // bumped by stop(); stale runs self-discard
    this.inFlight = false;
    this.manualQueued = false;
    this.lastManualAt = 0;
    this.lastRunAt = 0;
  }

  intervalWithJitter(intervalMs) {
    const jitter = intervalMs * JITTER_FRACTION;
    return Math.max(30_000, Math.round(intervalMs + (this.random() * 2 - 1) * jitter));
  }

  /** Start looping with the given interval in minutes. */
  start(intervalMinutes) {
    this.stop();
    const intervalMs = Math.max(60_000, intervalMinutes * 60_000);
    const gen = ++this.generation;
    const tick = async () => {
      if (gen !== this.generation) return;
      await this.runOnce(gen);
    };
    // First run promptly, then at jittered cadence.
    this.timer = this.setIntervalMs(tick, this.intervalWithJitter(intervalMs));
    tick();
    return this.timer;
  }

  /** One guarded run; re-entrancy protected. */
  async runOnce(gen) {
    if (gen !== this.generation) return;
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastRunAt = Date.now();
    try {
      await this.runFn();
    } catch {
      // runFn contract says never throw; belt and braces.
    } finally {
      this.inFlight = false;
      // A manual refresh that arrived mid-flight runs once the current poll
      // completes (coalesced, not dropped).
      if (this.manualQueued && gen === this.generation) {
        this.manualQueued = false;
        this.runOnce(gen);
      }
    }
  }

  /**
   * Manual refresh: debounced and coalesced. Returns true when a run was
   * actually triggered now, false when suppressed.
   */
  refreshNow() {
    const now = Date.now();
    if (this.inFlight) { this.manualQueued = true; return false; }
    if (now - this.lastManualAt < DEBOUNCE_MS) return false;
    this.lastManualAt = now;
    this.runOnce(this.generation);
    return true;
  }

  /** Stop the loop and cancel in-flight work. */
  stop() {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.generation++;
  }
}

module.exports = { Scheduler, DEBOUNCE_MS };
