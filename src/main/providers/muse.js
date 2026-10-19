'use strict';

/**
 * Muse (muse-wonder) adapter.
 *
 * Uses the installed Muse's MSP session host (`muse serve`,
 * newline-delimited JSON-RPC) and its `usage/read` method, which returns
 * the host's last-observed subscription usage: the 5-hour-class window and
 * the rolling weekly window as provider percentages, plus the tier.
 * - Background polls are metadata-only: no session is started and no turn
 *   is run. Muse's credential file is never read or written by us; the
 *   CLI handles its own auth internally.
 * - A fresh host has observed nothing, so `usage/read` may legitimately
 *   return no usage member. That is reported as NO_DATA (Waiting), never
 *   as invented numbers. Readings keep the host's `observedAtMs` stamp,
 *   so an old observation is shown with its real age and goes cached.
 * - Only when the user presses Refresh (`force`), the host runs one tiny
 *   prompt so the provider's usage frame reaches it, then reads usage.
 *   That single user-initiated prompt is the tracker's only inference.
 *
 * Windows note: `muse` on PATH is a `.cmd` launcher shim, and Node refuses
 * to spawn `.cmd`/`.bat` directly (EINVAL, CVE-2024-27980 hardening). The
 * install also carries a versioned `muse-bin-<version>.exe`; we spawn that
 * directly when present and only fall back to a cmd.exe wrap otherwise.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clampPercent, okSnapshot, errorSnapshot } = require('./model');
const { windowKindForDuration, windowLabel } = require('./codex');

const REQUEST_TIMEOUT_MS = 15_000;
const FORCED_TIMEOUT_MS = 90_000;
const SERVE_ARGS = ['serve', '--no-session-log'];
const NO_DATA_MESSAGE = 'Muse has not reported subscription usage yet (press Refresh and the tracker will run one tiny Muse prompt to read it)';
const TINY_PROMPT = 'Reply only: OK';

/** UUIDv7 (MSP command ids must be UUIDv7; the host refuses anything else). */
function uuidv7(randomBytes = crypto.randomBytes) {
  const b = randomBytes(16);
  const t = BigInt(Date.now());
  b[0] = Number((t >> 40n) & 0xffn);
  b[1] = Number((t >> 32n) & 0xffn);
  b[2] = Number((t >> 24n) & 0xffn);
  b[3] = Number((t >> 16n) & 0xffn);
  b[4] = Number((t >> 8n) & 0xffn);
  b[5] = Number(t & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Epoch milliseconds -> ISO, or null for unusable values. */
function msToIso(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize a `usage/read` result into windows keyed by semantic kind.
 * Pure; exported for fixture tests.
 *
 * Result shape (from the binary's own MSP schema export, `muse schema`):
 * { usage?: { tier, observedAtMs,
 *     window: { usedPercent, resetsAtMs, windowDurationMins },
 *     weekly: { usedPercent, resetsAtMs } } }
 * `usage` is omitted (never null) when the host has observed nothing.
 */
function normalizeMuseUsage(result, now = Date.now()) {
  const usage = result && typeof result === 'object' ? result.usage : null;
  if (!usage || typeof usage !== 'object') {
    return errorSnapshot('muse', 'NO_DATA', NO_DATA_MESSAGE);
  }
  const windows = [];
  const w = usage.window;
  if (w && typeof w === 'object') {
    const percent = clampPercent(w.usedPercent);
    const mins = Number(w.windowDurationMins);
    if (percent !== null) {
      const kind = windowKindForDuration(mins);
      windows.push({
        id: 'muse:window',
        kind,
        label: windowLabel(kind, mins),
        usedPercent: percent,
        resetsAt: msToIso(Number(w.resetsAtMs)),
        periodSeconds: Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : null,
      });
    }
  }
  const weekly = usage.weekly;
  if (weekly && typeof weekly === 'object') {
    const percent = clampPercent(weekly.usedPercent);
    if (percent !== null) {
      windows.push({
        id: 'muse:weekly',
        kind: 'weekly',
        label: 'Week',
        usedPercent: percent,
        resetsAt: msToIso(Number(weekly.resetsAtMs)),
        periodSeconds: 7 * 24 * 3600,
      });
    }
  }
  if (!windows.length) return errorSnapshot('muse', 'NO_DATA', NO_DATA_MESSAGE);
  const observed = Number(usage.observedAtMs);
  const fetchedAt = Number.isFinite(observed) && observed > 0 ? Math.min(observed, now) : now;
  // Tier ids are opaque (a long numeric id on current builds); only a
  // human-readable tier name is worth showing as the plan label.
  const plan = typeof usage.tier === 'string' && /[A-Za-z]/.test(usage.tier) ? usage.tier.slice(0, 40) : null;
  return {
    ...okSnapshot('muse', { plan, windows, notes: ['From Muse local host'], fetchedAt }),
    source: 'muse-serve',
  };
}

/** `muse-bin-1.4.11-R6667.1.exe` -> `1.4.11-R6667.1`; null otherwise. */
function parseMuseBinName(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(/^muse-bin-(\d+\.\d+\.\d+(?:-R\d+(?:\.\d+)?)?)\.exe$/i);
  return m ? m[1] : null;
}

function compareVersions(a, b) {
  const parts = (v) => v.split(/[-.]/).map((p) => {
    const n = parseInt(p.replace(/^R/i, ''), 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Newest versioned `muse-bin-*.exe` in the install dir, or null. */
function findInstalledMuseExe(deps = {}) {
  const readdir = deps.readdirSync || fs.readdirSync;
  const dir = deps.installDir !== undefined ? deps.installDir
    : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'muse');
  if (!dir) return null;
  let names;
  try { names = readdir(dir); } catch { return null; }
  const found = names
    .map((name) => ({ name, version: parseMuseBinName(name) }))
    .filter((x) => x.version)
    .sort((a, b) => compareVersions(b.version, a.version));
  return found.length ? path.join(dir, found[0].name) : null;
}

/** Resolve the muse command on Windows (PATH lookup, .exe/.cmd). */
function resolveMuseCommand(env = process.env) {
  const pathVar = env.PATH || '';
  const exts = env.PATHEXT ? env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT'];
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = `${dir}\\muse${ext.toLowerCase()}`;
      try {
        fs.accessSync(full);
        return full;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

/**
 * Resolve Muse to a spawnable target:
 *  - the versioned install exe, or a native .exe on PATH -> spawn directly
 *  - a .cmd/.bat launcher shim -> cmd.exe /c wrap (constant args)
 * `deps.command` / `deps.installDir` are injectable for tests; an explicit
 * `command: null` means "not on PATH" and skips the PATH scan.
 */
function resolveMuseTarget(env = process.env, deps = {}) {
  const cmd = deps.command !== undefined ? deps.command : (findInstalledMuseExe(deps) || resolveMuseCommand(env));
  if (!cmd) return null;
  const lower = cmd.toLowerCase();
  if (lower.endsWith('.exe')) return { exe: cmd, args: [] };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // The shim's own folder carries the versioned exe on the standard
    // install layout; spawning that directly is more reliable than
    // wrapping the shim (Node's cmd.exe argument quoting mangles it).
    const sibling = findInstalledMuseExe({ ...deps, installDir: path.dirname(cmd) });
    if (sibling) return { exe: sibling, args: [] };
    return { exe: 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd}" ${SERVE_ARGS.join(' ')}`], serveInArgs: true };
  }
  return null;
}

/**
 * Transport: spawn `muse serve`, run initialize -> initialized ->
 * usage/read, normalize. By default this starts no session and runs no
 * turn, so it makes no model call, and a fresh host reports NO_DATA.
 *
 * With `deps.force` (the user pressed Refresh), the host first runs ONE
 * tiny prompt ("Reply only: OK", reasoning effort none, memory-only
 * session in a temp workspace) so the provider's usage frame reaches this
 * host, then reads usage. That is the only inference the tracker ever
 * makes, and only on an explicit user refresh. `deps` is injectable for
 * tests: { spawnImpl, target, force, prompt, workspaceRoot }.
 */
async function fetchMuseQuotas(deps = {}) {
  const { spawnImpl = spawn, signal } = deps;
  const force = !!deps.force;
  if (signal && signal.aborted) return errorSnapshot('muse', 'ABORTED', 'Muse poll aborted');
  const resolved = deps.target || (typeof deps.resolveTarget === 'function'
    ? deps.resolveTarget()
    : resolveMuseTarget(process.env, deps));
  if (!resolved) return errorSnapshot('muse', 'NO_CLI', 'Muse not found (install Muse and sign in)');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(resolved.exe, [...resolved.args, ...(resolved.serveInArgs ? [] : SERVE_ARGS)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
    } catch (cause) {
      resolve(errorSnapshot('muse', 'NO_CLI', `Could not start Muse: ${cause.message}`));
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
      if (signal) signal.removeEventListener('abort', abort);
      lines.removeAllListeners('line');
      child.stderr.removeListener('data', onStderr);
      child.removeListener('exit', onExit);
      lines.close();
      if (child.exitCode !== null && child.exitCode !== undefined) { resolve(snap); return; }
      let killTimer = null;
      const terminated = () => {
        clearTimeout(killTimer);
        child.removeListener('exit', terminated);
        child.removeListener('close', terminated);
        resolve(snap);
      };
      child.once('exit', terminated);
      child.once('close', terminated);
      killTimer = setTimeout(() => {
        snap.retrySafe = false;
        terminated();
      }, 200);
      try { child.kill(); } catch { /* bounded cleanup wait below */ }
    };

    const send = (msg) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    const fail = (code, message) => finish(errorSnapshot('muse', code, message));
    const abort = () => fail('ABORTED', 'Muse poll aborted');

    timer = setTimeout(() => fail('TIMEOUT', 'Muse host timed out'), force ? FORCED_TIMEOUT_MS : REQUEST_TIMEOUT_MS);

    child.on('error', (cause) => {
      fail('NO_CLI', cause.code === 'ENOENT' ? 'Muse not found' : `Could not start Muse: ${cause.message}`);
    });

    const onStderr = (chunk) => {
      // Small diagnostic tail only; never forwarded on success.
      stderrTail = (stderrTail + chunk.toString()).slice(-300);
    };
    child.stderr.on('data', onStderr);

    const onExit = (code) => {
      if (settled) return;
      const detail = stderrTail.trim().split(/\r?\n/).pop();
      fail('EXIT', detail || `Muse host exited with code ${code}`);
    };
    child.on('exit', onExit);

    const rpcFail = (error) => {
      const msgText = (error && error.message) || 'Muse host request failed';
      const noAuth = /auth|log[ -]?in|credential/i.test(msgText);
      fail(noAuth ? 'NO_AUTH' : 'RPC', msgText);
    };
    let usageRequested = false;
    const readUsage = (id) => {
      if (usageRequested) return;
      usageRequested = true;
      send({ jsonrpc: '2.0', id, method: 'usage/read' });
    };

    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }

      if (message.id === 0) {
        if (message.error) { rpcFail(message.error); return; }
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        if (force) {
          send({
            jsonrpc: '2.0',
            id: 1,
            method: 'session/start',
            params: { commandId: uuidv7(), workspaceRoot: deps.workspaceRoot || os.tmpdir() },
          });
        } else {
          readUsage(1);
        }
        return;
      }
      if (force && message.id === 1) {
        if (message.error) { rpcFail(message.error); return; }
        const sessionId = message.result && message.result.session && message.result.session.sessionId;
        if (!sessionId) { fail('RPC', 'Muse host returned no session'); return; }
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'turn/start',
          params: {
            commandId: uuidv7(),
            sessionId,
            reasoningEffort: 'none',
            input: [{ type: 'text', text: deps.prompt || TINY_PROMPT }],
          },
        });
        return;
      }
      if (force && message.id === 2) {
        if (message.error) rpcFail(message.error);
        return; // turn accepted; completion arrives as a notification
      }
      if (message.id === (force ? 3 : 1)) {
        if (message.error) { rpcFail(message.error); return; }
        finish(normalizeMuseUsage(message.result || {}));
        return;
      }
      if (force && (message.method === 'turn/completed' || message.method === 'usage/changed')) {
        readUsage(3);
      }
    });

    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
    }
    send({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'ai_usage_tracker', title: 'AI Usage Tracker', version: '1.0.0' } },
    });
  });
}

module.exports = {
  fetchMuseQuotas, normalizeMuseUsage, resolveMuseTarget, resolveMuseCommand,
  findInstalledMuseExe, parseMuseBinName, NO_DATA_MESSAGE, TINY_PROMPT, uuidv7,
};
