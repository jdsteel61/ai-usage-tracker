'use strict';

/**
 * OpenAI Codex adapter.
 *
 * Uses the installed, authenticated Codex CLI's app-server interface
 * (`codex app-server`, newline-delimited JSON-RPC) and its
 * `account/rateLimits/read` method. This is a metadata-only query:
 * - no inference request is made,
 * - the Codex credential file is never read or written by us; the CLI
 *   handles its own auth internally,
 * - we only ever parse the rate-limit view it prints on stdout.
 *
 * The JSON-RPC handshake mirrors what the CLI expects (initialize ->
 * initialized -> request -> response). Transport is injectable so tests
 * run against fixtures without spawning anything.
 *
 * Windows note: `codex` on PATH is an npm `.cmd` shim, and Node refuses to
 * spawn `.cmd`/`.bat` directly (EINVAL, CVE-2024-27980 hardening). We parse
 * the shim to its real target and spawn THAT: `node.exe codex.js app-server`.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { clampPercent, okSnapshot, errorSnapshot } = require('./model');

const REQUEST_TIMEOUT_MS = 15_000;

/** Codex `windowDurationMins` -> semantic window kind. */
function windowKindForDuration(mins) {
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return 'other';
  if (mins <= 12 * 60) return 'session'; // the ~5h rolling window family
  if (mins > 24 * 60 && mins <= 8 * 24 * 60) return 'weekly'; // 7-day family (daily stays 'other')
  return 'other';
}

/** Label like the mock: '5 hr' for 300-minute windows, 'Week', 'Daily', ... */
function windowLabel(kind, mins) {
  if (kind === 'session') return mins % 60 === 0 ? `${mins / 60} hr` : `${mins}m`;
  if (kind === 'weekly') return 'Week';
  if (mins === 1440) return 'Day';
  if (mins > 0 && mins % 1440 === 0) return `${mins / 1440}-day`;
  return 'Usage';
}

/** Convert the CLI's epoch-seconds resetsAt to ISO, tolerating ms values. */
function resetToIso(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds > 1e12 ? seconds : seconds * 1000; // already-ms guard
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize an `account/rateLimits/read` result into windows keyed by
 * semantic kind. Pure; exported for fixture tests.
 *
 * Result shape (verified against Codex CLI app-server):
 * { rateLimitsByLimitId?: { [id]: { limitId, limitName, planType, credits,
 *     primary:  { usedPercent, resetsAt (epoch s), windowDurationMins },
 *     secondary:{ ... } } } }
 */
function normalizeCodexResult(result) {
  const byId = result && result.rateLimitsByLimitId;
  const limits = byId && typeof byId === 'object'
    ? Object.values(byId).filter((l) => l && typeof l === 'object')
    : (Array.isArray(result && result.rateLimits) ? result.rateLimits.filter(Boolean) : []);

  const windows = [];
  const notes = [];
  for (const limit of limits) {
    for (const slot of ['primary', 'secondary']) {
      const w = limit[slot];
      if (!w || typeof w !== 'object') continue;
      const percent = clampPercent(w.usedPercent);
      if (percent === null && !Number.isFinite(w.resetsAt)) continue;
      const mins = Number(w.windowDurationMins);
      const kind = windowKindForDuration(mins);
      windows.push({
        id: `codex:${limit.limitId || 'codex'}:${slot}`,
        kind,
        label: windowLabel(kind, mins),
        usedPercent: percent,
        resetsAt: resetToIso(Number(w.resetsAt)),
        periodSeconds: Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : null,
      });
    }
  }

  const first = limits[0] || {};
  const plan = typeof first.planType === 'string' && first.planType ? first.planType : null;
  if (plan && /api/i.test(plan)) notes.push('API-key-style plan; subscription windows may not apply');
  if (windows.length === 0) notes.push('Codex returned no subscription windows');
  return okSnapshot('codex', { plan, windows, notes });
}

/** Resolve the codex command on Windows (PATH lookup, .cmd/.exe). */
function resolveCodexCommand(env = process.env) {
  const pathVar = env.PATH || '';
  const exts = env.PATHEXT ? env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT'];
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = `${dir}\\codex${ext.toLowerCase()}`;
      try {
        require('fs').accessSync(full);
        return full;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

/**
 * Parse a standard npm `.cmd` shim ("%dp0%\\node_modules\\...\\codex.js")
 * into a directly spawnable { exe, args }. Pure-ish: readers injectable.
 */
function parseShimTarget(cmdPath, readFileSyncImpl, existsSyncImpl) {
  const read = readFileSyncImpl || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = existsSyncImpl || ((p) => fs.existsSync(p));
  const shimDir = path.dirname(cmdPath);
  let text;
  try {
    text = read(cmdPath);
  } catch {
    return null;
  }
  const m = text.match(/"([^"\r\n]+?\.js)"/i);
  if (!m) return null;
  const target = m[1].replace(/%dp0%/gi, shimDir);
  const nodeExe = path.join(shimDir, 'node.exe');
  const exe = exists(nodeExe) ? nodeExe : 'node';
  return { exe, args: [target] };
}

/**
 * Resolve codex to a spawnable target:
 *  - native .exe -> spawn directly
 *  - npm .cmd shim -> node.exe + real codex.js
 *  - unparsable shim -> cmd.exe /c fallback (constant args, no injection)
 */
function resolveCodexTarget(env = process.env, deps = {}) {
  const cmd = deps.command || resolveCodexCommand(env);
  if (!cmd) return null;
  const lower = cmd.toLowerCase();
  if (lower.endsWith('.exe')) return { exe: cmd, args: [] };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const parsed = parseShimTarget(cmd, deps.readFileSync, deps.existsSync);
    if (parsed) return parsed;
    return { exe: 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd}" app-server`] };
  }
  return null;
}

/**
 * Transport: spawn `codex app-server`, run the handshake, normalize.
 * `deps` is injectable for tests: { spawnImpl, target }.
 */
async function fetchCodexQuotas({ spawnImpl = spawn, target } = {}) {
  const resolved = target || resolveCodexTarget();
  if (!resolved) return errorSnapshot('codex', 'NO_CLI', 'Codex CLI not found on PATH');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(resolved.exe, [...resolved.args, 'app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      resolve(errorSnapshot('codex', 'NO_CLI', `Could not start Codex CLI: ${cause.message}`));
      return;
    }

    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderrTail = '';
    let timer = null;

    const finish = (snap) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      lines.close();
      try { child.kill(); } catch { /* already gone */ }
      resolve(snap);
    };

    const send = (msg) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    const fail = (code, message) => finish(errorSnapshot('codex', code, message));

    timer = setTimeout(() => fail('TIMEOUT', 'Codex app-server timed out'), REQUEST_TIMEOUT_MS);

    child.on('error', (cause) => {
      fail('NO_CLI', cause.code === 'ENOENT' ? 'Codex CLI not found' : `Could not start Codex CLI: ${cause.message}`);
    });

    child.stderr.on('data', (chunk) => {
      // Small diagnostic tail only; never forwarded on success.
      stderrTail = (stderrTail + chunk.toString()).slice(-300);
    });

    child.on('exit', (code) => {
      if (settled) return;
      const detail = stderrTail.trim().split(/\r?\n/).pop();
      fail('EXIT', detail || `Codex app-server exited with code ${code}`);
    });

    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }

      if (message.id === 0) {
        if (message.error) {
          fail('RPC', message.error.message || 'Codex app-server request failed');
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1 });
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          const msgText = message.error.message || 'Codex app-server request failed';
          const noAuth = /auth|log[ -]?in|credential/i.test(msgText);
          fail(noAuth ? 'NO_AUTH' : 'RPC', msgText);
          return;
        }
        finish(normalizeCodexResult(message.result || {}));
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'ai_usage_tracker', title: 'AI Usage Tracker', version: '1.0.0' } },
    });
  });
}

module.exports = { fetchCodexQuotas, normalizeCodexResult, resolveCodexCommand, resolveCodexTarget, parseShimTarget, windowKindForDuration, windowLabel, resetToIso };
