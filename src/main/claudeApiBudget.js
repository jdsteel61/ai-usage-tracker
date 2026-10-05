'use strict';

/**
 * Rate budget for the opt-in Claude usage API top-up. That endpoint rate-limits
 * very aggressively (sometimes retry-after:0 or absent, for hours), so every
 * call is gated here:
 * - at least MIN_INTERVAL_MS between calls for one profile,
 * - at most one call started per STAGGER_MS across all profiles,
 * - HTTP 429 waits the longest of: any cooldown still running, the escalation
 *   step (1h, 2h, then 4h), and a valid Retry-After up to 24h, plus a little
 *   positive jitter. A Retry-After never shortens an established cooldown.
 *   Escalation eases one step after several successes or a long quiet spell,
 *   not after a single success,
 * - 401/403 blocks the profile until its local capture or credentials change.
 * In-process delays use a monotonic clock, so wall-clock changes cannot end a
 * wait early. Persisted wall-clock deadlines are reconciled conservatively on
 * load. State survives restarts: only timestamps and counters are written, to
 * a file plus a one-step backup. If existing state cannot be recovered or
 * saved, API top-ups are suspended (local capture is unaffected) rather than
 * left unrestricted. A call is dispatched only after its reservation is saved.
 * Clocks are injectable for tests.
 */
const fs = require('fs');
const { writeFileAtomic } = require('./atomicWrite');

const MIN_INTERVAL_MS = 10 * 60_000;
const STAGGER_MS = 60_000;
const BACKOFF_MS = [60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000];
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const JITTER_FRACTION = 0.1;
const MAX_WAIT_MS = 30 * 60 * 60_000; // longest believable persisted deadline
const SUCCESSES_TO_EASE = 3;
const QUIET_EASE_MS = 12 * 60 * 60_000;
const UNRECOVERABLE_BLOCK_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 64;

function finite(value) { return Number.isFinite(value) ? value : null; }
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

class ClaudeApiBudget {
  constructor(filePath = null, { now = Date.now, mono = monotonicMs, random = Math.random, fsImpl = fs } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.mono = mono;
    this.random = random;
    this.fs = fsImpl;
    this.lastStartMono = null;
    this.blockUntilMono = 0;
    this.profiles = {};
    this.lastRaw = null;
    this.unsaved = false;
    this.load();
  }

  entry(id) {
    return (this.profiles[id] = this.profiles[id] || {
      lastMono: null, untilMono: 0, failures: 0, successes: 0, lastFailMono: null, auth: null,
    });
  }

  remaining(untilMono) { return Math.max(0, untilMono - this.mono()); }

  /** Monotonic stamp for a persisted wall-clock time; a time in the future (clock moved back) counts as "just now". */
  stampFromWall(wallAt) {
    const elapsed = Math.max(0, this.now() - wallAt);
    return this.mono() - elapsed;
  }

  wallFromStamp(stamp) { return this.now() - Math.max(0, this.mono() - stamp); }

  // ------------------------------------------------------------ persistence

  readState(file) {
    let text;
    try { text = this.fs.readFileSync(file, 'utf8'); }
    catch (cause) { return { state: cause && cause.code === 'ENOENT' ? 'missing' : 'bad' }; }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)
          || !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) return { state: 'bad' };
      return { state: 'ok', data, text };
    } catch { return { state: 'bad' }; }
  }

  load() {
    if (!this.filePath) return;
    const main = this.readState(this.filePath);
    if (main.state === 'ok') { this.adopt(main.data); this.lastRaw = main.text; return; }
    const backup = this.readState(`${this.filePath}.bak`);
    if (backup.state === 'ok') {
      this.adopt(backup.data);
      this.lastRaw = backup.text;
      this.lastStartMono = this.mono(); // calls since the backup are unknown
      this.save();
    } else if (main.state === 'missing' && backup.state === 'missing') {
      // genuinely first run: nothing has ever been recorded
    } else {
      // State existed but cannot be recovered: stay quiet for the longest ban.
      this.blockUntilMono = this.mono() + UNRECOVERABLE_BLOCK_MS;
      this.save();
    }
  }

  adopt(data) {
    const lastStart = finite(data.lastStartAt);
    if (lastStart) this.lastStartMono = this.stampFromWall(lastStart);
    const block = finite(data.blockUntilAt);
    if (block) this.blockUntilMono = this.mono() + Math.min(Math.max(0, block - this.now()), MAX_WAIT_MS);
    for (const [id, raw] of Object.entries(data.profiles)) {
      if (!raw || typeof raw !== 'object' || id.length > 120) continue;
      const auth = raw.auth && typeof raw.auth === 'object'
        ? { credMtimeMs: finite(raw.auth.credMtimeMs), localAt: finite(raw.auth.localAt) || 0 } : null;
      const lastCall = finite(raw.lastCallAt);
      const retry = finite(raw.retryAt);
      const lastFail = finite(raw.lastFailureAt);
      this.profiles[id] = {
        lastMono: lastCall ? this.stampFromWall(lastCall) : null,
        untilMono: retry ? this.mono() + Math.min(Math.max(0, retry - this.now()), MAX_WAIT_MS) : 0,
        failures: Math.min(Math.max(Math.floor(finite(raw.failures) || 0), 0), BACKOFF_MS.length),
        successes: Math.min(Math.max(Math.floor(finite(raw.successes) || 0), 0), SUCCESSES_TO_EASE),
        lastFailMono: lastFail ? this.stampFromWall(lastFail) : null,
        auth,
      };
    }
    this.prune();
  }

  serialize() {
    const profiles = {};
    for (const [id, e] of Object.entries(this.profiles)) {
      const left = this.remaining(e.untilMono);
      profiles[id] = {
        lastCallAt: e.lastMono === null ? 0 : this.wallFromStamp(e.lastMono),
        retryAt: left > 0 ? this.now() + left : 0,
        failures: e.failures,
        successes: e.successes,
        lastFailureAt: e.lastFailMono === null ? 0 : this.wallFromStamp(e.lastFailMono),
        auth: e.auth,
      };
    }
    const blocked = this.remaining(this.blockUntilMono);
    return JSON.stringify({
      version: 1,
      lastStartAt: this.lastStartMono === null ? 0 : this.wallFromStamp(this.lastStartMono),
      blockUntilAt: blocked > 0 ? this.now() + blocked : 0,
      profiles,
    });
  }

  /** Durable save (backup of the previous state first). Returns false when it did not reach disk. */
  save() {
    if (!this.filePath) return true;
    this.prune();
    try {
      const raw = this.serialize();
      if (this.lastRaw) {
        try { writeFileAtomic(`${this.filePath}.bak`, this.lastRaw, { fsImpl: this.fs }); }
        catch { /* the backup is best effort; the main file still matters */ }
      }
      writeFileAtomic(this.filePath, raw, { fsImpl: this.fs });
      this.lastRaw = raw;
      this.unsaved = false;
      return true;
    } catch {
      this.unsaved = true;
      return false;
    }
  }

  /** Forget quiet entries, then enforce the size limit without ever dropping a live cooldown or auth block. */
  prune() {
    const mono = this.mono();
    for (const [id, e] of Object.entries(this.profiles)) {
      this.easeByQuiet(e);
      if (!this.isBlocking(e) && !this.isBusy(e, mono) && e.failures === 0) delete this.profiles[id];
    }
    const ids = Object.keys(this.profiles);
    if (ids.length <= MAX_ENTRIES) return;
    const droppable = ids.filter((id) => !this.isBlocking(this.profiles[id]))
      .sort((a, b) => (this.profiles[a].lastMono ?? -Infinity) - (this.profiles[b].lastMono ?? -Infinity));
    for (const id of droppable.slice(0, ids.length - MAX_ENTRIES)) delete this.profiles[id];
  }

  isBlocking(e) { return !!e.auth || this.remaining(e.untilMono) > 0; }
  isBusy(e, mono = this.mono()) { return e.lastMono !== null && mono - e.lastMono < MIN_INTERVAL_MS; }

  /** One escalation step eases per QUIET_EASE_MS without a failure. */
  easeByQuiet(e) {
    if (e.failures > 0 && e.lastFailMono !== null) {
      const steps = Math.floor((this.mono() - e.lastFailMono) / QUIET_EASE_MS);
      if (steps > 0) {
        e.failures = Math.max(0, e.failures - steps);
        e.lastFailMono = e.failures > 0 ? e.lastFailMono + steps * QUIET_EASE_MS : null;
      }
    }
  }

  // ------------------------------------------------------------ decisions

  /** `state`: { credMtimeMs, localAt } describing the profile's current inputs.
   * Returns { ok: true } or { ok: false, reason: 'suspended'|'auth'|'cooldown'|'interval'|'stagger', retryAt }. */
  check(id, { credMtimeMs = null, localAt = 0 } = {}) {
    const mono = this.mono();
    if (this.unsaved && !this.save()) return { ok: false, reason: 'suspended', retryAt: null };
    const blocked = this.remaining(this.blockUntilMono);
    if (blocked > 0) return { ok: false, reason: 'suspended', retryAt: this.now() + blocked };
    const e = this.entry(id);
    if (e.auth) {
      if (e.auth.credMtimeMs !== credMtimeMs || localAt > e.auth.localAt) {
        e.auth = null; // sign-in material changed: allow one new attempt
        this.save();
      } else return { ok: false, reason: 'auth', retryAt: null };
    }
    const cooling = this.remaining(e.untilMono);
    if (cooling > 0) return { ok: false, reason: 'cooldown', retryAt: this.now() + cooling };
    if (this.isBusy(e, mono)) return { ok: false, reason: 'interval', retryAt: this.now() + MIN_INTERVAL_MS - (mono - e.lastMono) };
    if (this.lastStartMono !== null && mono - this.lastStartMono < STAGGER_MS) {
      return { ok: false, reason: 'stagger', retryAt: this.now() + STAGGER_MS - (mono - this.lastStartMono) };
    }
    return { ok: true };
  }

  /** Record a call before it is sent, so a crash mid-call still counts. Returns
   * false when the reservation could not be saved: the caller must not send. */
  begin(id) {
    const mono = this.mono();
    this.entry(id).lastMono = mono;
    this.lastStartMono = mono;
    return this.save();
  }

  success(id) {
    const e = this.entry(id);
    e.untilMono = 0;
    e.auth = null;
    if (e.failures > 0 && ++e.successes >= SUCCESSES_TO_EASE) {
      e.failures -= 1;
      e.successes = 0;
      if (e.failures === 0) e.lastFailMono = null;
    }
    this.save();
  }

  /** `retryAfterMs`: parsed Retry-After header, or null when absent/unusable.
   * Returns the wall-clock time before which no further call is made. */
  rateLimited(id, retryAfterMs = null) {
    const e = this.entry(id);
    this.easeByQuiet(e);
    const valid = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : 0;
    const step = BACKOFF_MS[Math.min(e.failures, BACKOFF_MS.length - 1)];
    const base = Math.max(this.remaining(e.untilMono), step, valid, MIN_INTERVAL_MS);
    const wait = base + Math.floor(Math.max(0, this.random()) * base * JITTER_FRACTION);
    e.failures = Math.min(e.failures + 1, BACKOFF_MS.length);
    e.successes = 0;
    e.lastFailMono = this.mono();
    e.untilMono = this.mono() + wait;
    this.save();
    return this.now() + wait;
  }

  authFailed(id, { credMtimeMs = null, localAt = 0 } = {}) {
    this.entry(id).auth = { credMtimeMs, localAt };
    this.save();
  }

  /** Drop a profile's state (profile removed). */
  purge(id) {
    if (!Object.hasOwn(this.profiles, id)) return;
    delete this.profiles[id];
    this.save();
  }

  /** Keep state only for the given profile ids (startup housekeeping). */
  retainOnly(ids) {
    const keep = new Set(ids);
    let changed = false;
    for (const id of Object.keys(this.profiles)) {
      if (!keep.has(id)) { delete this.profiles[id]; changed = true; }
    }
    if (changed) this.save();
  }

  /** Public view for status text: { retryAt, authBlocked }. */
  status(id) {
    const e = this.profiles[id];
    if (!e) return { retryAt: null, authBlocked: false };
    const left = this.remaining(e.untilMono);
    return { retryAt: left > 0 ? this.now() + left : null, authBlocked: !!e.auth };
  }

  /** Monotonic time of the profile's last call attempt, or -Infinity: used to rotate fairly. */
  lastAttempt(id) {
    const e = this.profiles[id];
    return e && e.lastMono !== null ? e.lastMono : -Infinity;
  }
}

/** Retry-After header value (delta-seconds or HTTP date) in ms, or null. */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date - now : null;
}

module.exports = {
  ClaudeApiBudget, parseRetryAfter, MIN_INTERVAL_MS, STAGGER_MS, BACKOFF_MS, MAX_RETRY_AFTER_MS,
  SUCCESSES_TO_EASE, QUIET_EASE_MS, UNRECOVERABLE_BLOCK_MS, MAX_ENTRIES,
};
