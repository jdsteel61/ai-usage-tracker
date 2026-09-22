'use strict';

/**
 * Diagnostics logger with mandatory redaction. Anything that reaches this
 * logger passes through `redact()` first: bearer tokens, API keys, cookies,
 * authorization headers, raw credential JSON fields, long secret-looking
 * blobs, and the user's home-directory path.
 *
 * Log file: userData/logs/main.log (rotates at ~512 KB). The logger is also
 * the single console surface of the main process.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LOG_BYTES = 512 * 1024;
// Ordered: most-specific patterns first so a Bearer header is consumed before
// the generic field matcher can half-match it.
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9\-_]{16,}/g;
const ZAI_KEY_RE = /[A-Fa-f0-9]{32}\.[A-Za-z0-9_-]{6,}/g; // zai key format: hex32.dot-id
const SECRET_FIELD_RE = /\b(accessToken|refresh[_-]?token|api[_-]?key|apiKey|password|secret|credential|authorization|cookie|token)["']?\s*[:=]\s*("?)(?!Bearer\b|Basic\b|\[)[^"'\s,}]{4,}\2/gi;
const LONG_BLOB_RE = /\b[A-Za-z0-9+/=_-]{40,}\b/g; // long base64/hex-ish blobs
const HOME_RE = new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
const USERS_DIR_RE = /([A-Za-z]:\\+Users\\+)[^\\"\s]+/gi; // any local profile path

/** Redact a single string. Order matters: structured fields first. */
function redact(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  out = out.replace(BEARER_RE, '$1 [REDACTED]');
  out = out.replace(OPENAI_KEY_RE, '[REDACTED]');
  out = out.replace(ZAI_KEY_RE, '[REDACTED]');
  out = out.replace(SECRET_FIELD_RE, '$1=[REDACTED]');
  out = out.replace(LONG_BLOB_RE, (m) => (m.includes('[REDACTED]') ? m : '[REDACTED]'));
  out = out.replace(HOME_RE, '~');
  out = out.replace(USERS_DIR_RE, '$1~');
  return out;
}

/** Redact recursively through plain objects/arrays (shallow depth guard). */
function redactDeep(value, depth = 0) {
  if (typeof value === 'string') return redact(value);
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    this.enabled = !!filePath;
  }

  open() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.enabled = true;
    } catch { this.enabled = false; }
  }

  _write(level, scope, message) {
    const line = `${new Date().toISOString()} ${level} [${scope}] ${redact(String(message))}\n`;
    process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
    if (this.enabled) {
      try {
        this._rotateIfNeeded();
      } catch { /* rotation is best-effort */ }
      try {
        fs.appendFileSync(this.filePath, line);
      } catch { /* never crash on log IO */ }
    }
  }

  _rotateIfNeeded() {
    const st = fs.statSync(this.filePath);
    if (st.size > MAX_LOG_BYTES) {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    }
  }

  info(scope, message) { this._write('INFO', scope, message); }
  warn(scope, message) { this._write('WARN', scope, message); }
  error(scope, message) { this._write('ERROR', scope, message); }
  debug(scope, message) {
    if (process.env.AITRACKER_DEBUG) this._write('DEBUG', scope, message);
  }
}

module.exports = { redact, redactDeep, Logger };
