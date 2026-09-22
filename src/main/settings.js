'use strict';

/**
 * Settings persistence. Plain JSON under the Electron userData dir (injectable
 * path for tests). Contains NO secrets: the Z.ai key lives exclusively in
 * Windows Credential Manager. Unknown keys — especially secret-shaped ones —
 * are rejected so a secret can never leak into this file.
 */
const fs = require('fs');
const path = require('path');

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

const DEFAULTS = Object.freeze({
  providers: { codex: true, claude: true, zai: true, grok: false, gemini: false, openrouter: false },
  intervalMinutes: 5,
  percentMode: 'used', // 'used' | 'remaining'
  alwaysOnTop: true,
  launchAtLogin: false,
  theme: 'system', // 'light' | 'dark' | 'system'
  clock24: true,
  spikeAbsolutePoints: 8, // points within one polling interval
  spikeRelativePoints: 3, // minimum delta for the relative rule
  spikeRelativeMultiplier: 4, // rate must exceed median rate x this
  spikeAlertMinutes: 30, // how long the '!' stays up
  zaiBaseUrl: 'https://api.z.ai',
  windowBounds: null, // { x, y, width, height }
});

/** Keys whose shape is validated; anything else is dropped. */
const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;

  if (raw.providers && typeof raw.providers === 'object') {
    for (const id of Object.keys(DEFAULTS.providers)) {
      if (typeof raw.providers[id] === 'boolean') out.providers[id] = raw.providers[id];
    }
  }
  if (raw.intervalMinutes !== undefined) out.intervalMinutes = clampNumber(raw.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, DEFAULTS.intervalMinutes);
  if (raw.percentMode === 'remaining') out.percentMode = 'remaining';
  if (typeof raw.alwaysOnTop === 'boolean') out.alwaysOnTop = raw.alwaysOnTop;
  if (typeof raw.launchAtLogin === 'boolean') out.launchAtLogin = raw.launchAtLogin;
  if (['light', 'dark', 'system'].includes(raw.theme)) out.theme = raw.theme;
  if (typeof raw.clock24 === 'boolean') out.clock24 = raw.clock24;
  if (raw.spikeAbsolutePoints !== undefined) out.spikeAbsolutePoints = clampNumber(raw.spikeAbsolutePoints, 1, 100, DEFAULTS.spikeAbsolutePoints);
  if (raw.spikeRelativePoints !== undefined) out.spikeRelativePoints = clampNumber(raw.spikeRelativePoints, 1, 100, DEFAULTS.spikeRelativePoints);
  if (raw.spikeRelativeMultiplier !== undefined) out.spikeRelativeMultiplier = clampNumber(raw.spikeRelativeMultiplier, 1, 100, DEFAULTS.spikeRelativeMultiplier);
  if (raw.spikeAlertMinutes !== undefined) out.spikeAlertMinutes = clampNumber(raw.spikeAlertMinutes, 1, 24 * 60, DEFAULTS.spikeAlertMinutes);
  if (typeof raw.zaiBaseUrl === 'string' && /^https?:\/\//i.test(raw.zaiBaseUrl)) out.zaiBaseUrl = raw.zaiBaseUrl.replace(/\/+$/, '');
  if (raw.windowBounds && typeof raw.windowBounds === 'object'
      && Number.isFinite(raw.windowBounds.x) && Number.isFinite(raw.windowBounds.y)
      && Number.isFinite(raw.windowBounds.width) && Number.isFinite(raw.windowBounds.height)) {
    out.windowBounds = {
      x: Math.round(raw.windowBounds.x), y: Math.round(raw.windowBounds.y),
      width: Math.round(raw.windowBounds.width), height: Math.round(raw.windowBounds.height),
    };
  }
  return out;
}

/** Returns true when a key looks like it was meant to smuggle a secret in. */
function isSecretishKey(key) {
  return /(key|token|secret|password|credential|bearer|auth)/i.test(key);
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.values = { ...DEFAULTS };
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const key of Object.keys(raw)) {
        if (!ALLOWED_KEYS.has(key)) {
          if (isSecretishKey(key)) {
            throw new Error(`refusing to load secret-shaped setting '${key}'`);
          }
          continue; // drop unknown non-secret keys
        }
      }
      this.values = sanitize(raw);
    } catch (cause) {
      if (cause.code !== 'ENOENT') {
        // Corrupt or unsafe file: fall back to defaults (never crash the tray app).
        this.values = { ...DEFAULTS };
      }
    }
    return this.values;
  }

  get() {
    return this.values;
  }

  patch(partials) {
    this.values = sanitize({ ...this.values, ...partials });
    this.save();
    return this.values;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = {
  SettingsStore,
  sanitize,
  DEFAULTS,
  MIN_INTERVAL_MINUTES,
  isSecretishKey,
};
