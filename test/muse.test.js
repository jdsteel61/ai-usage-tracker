'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { normalizeMuseUsage, fetchMuseQuotas, resolveMuseTarget, parseMuseBinName } = require('../src/main/providers/muse');
const { findWindow } = require('../src/main/providers/model');

const FIX = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('muse: normalizes a usage/read result into session and weekly windows', () => {
  const snap = normalizeMuseUsage(FIX('muse-usage.json'));
  assert.equal(snap.ok, true);
  assert.equal(snap.providerId, 'muse');
  assert.equal(snap.plan, 'plus');
  const session = findWindow(snap, 'session');
  const weekly = findWindow(snap, 'weekly');
  assert.ok(session, 'session window present');
  assert.ok(weekly, 'weekly window present');
  assert.equal(session.usedPercent, 37);
  assert.equal(session.label, '5 hr');
  assert.equal(session.periodSeconds, 5 * 3600);
  assert.equal(session.resetsAt, new Date(1792453200000).toISOString());
  assert.equal(weekly.usedPercent, 12);
  assert.equal(weekly.label, 'Week');
  assert.equal(weekly.periodSeconds, 7 * 24 * 3600);
  assert.equal(weekly.resetsAt, new Date(1792886400000).toISOString());
  // The reading keeps the host's observation stamp, not the poll time.
  assert.equal(snap.fetchedAt, 1792448000000);
});

test('muse: no observed usage is NO_DATA, never invented numbers', () => {
  for (const result of [{}, { usage: undefined }, null, { usage: {} }, { usage: { tier: 'plus' } }]) {
    const snap = normalizeMuseUsage(result);
    assert.equal(snap.ok, false);
    assert.equal(snap.error.code, 'NO_DATA');
  }
});

test('muse: over-quota percentages clamp, malformed windows are skipped', () => {
  const snap = normalizeMuseUsage({
    usage: {
      tier: 'plus',
      window: { usedPercent: 140, resetsAtMs: 1792453200000, windowDurationMins: 300 },
      weekly: { usedPercent: 'high', resetsAtMs: 1792886400000 },
      observedAtMs: 1792449000000,
    },
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].usedPercent, 100);
});

test('muse: a non-5h-class window is not relabelled as the session window', () => {
  const snap = normalizeMuseUsage({
    usage: {
      tier: 'plus',
      window: { usedPercent: 5, resetsAtMs: 1792453200000, windowDurationMins: 1440 },
      weekly: { usedPercent: 5, resetsAtMs: 1792886400000 },
      observedAtMs: 1792449000000,
    },
  });
  assert.equal(findWindow(snap, 'session'), undefined);
  assert.ok(findWindow(snap, 'weekly'));
});

/** Minimal fake `muse serve` child: answers initialize, then usage/read. */
function fakeMuseServe(result) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
    let buf = '';
    child.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'muse', version: '0' } } })}\n`);
        } else if (msg.method === 'usage/read') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
        }
      }
    });
    return child;
  };
}

test('muse: fetch runs initialize -> usage/read over the serve host, no model call', async () => {
  const snap = await fetchMuseQuotas({
    spawnImpl: fakeMuseServe(FIX('muse-usage.json')),
    target: { exe: 'muse-fake', args: [] },
  });
  assert.equal(snap.ok, true);
  assert.equal(findWindow(snap, 'session').usedPercent, 37);
});

test('muse: fetch maps an empty usage/read result to NO_DATA', async () => {
  const snap = await fetchMuseQuotas({
    spawnImpl: fakeMuseServe({}),
    target: { exe: 'muse-fake', args: [] },
  });
  assert.equal(snap.ok, false);
  assert.equal(snap.error.code, 'NO_DATA');
});

test('muse: fetch reports NO_CLI when Muse is not installed', async () => {
  const snap = await fetchMuseQuotas({ target: null, resolveTarget: () => null });
  assert.equal(snap.ok, false);
  assert.equal(snap.error.code, 'NO_CLI');
});

test('muse: versioned binary names parse and sort newest first', () => {
  assert.equal(parseMuseBinName('muse-bin-1.4.11-R6667.1.exe'), '1.4.11-R6667.1');
  assert.equal(parseMuseBinName('muse.exe'), null);
  assert.equal(parseMuseBinName('other-1.4.11.exe'), null);
});

test('muse: resolveMuseTarget prefers a direct exe and wraps .cmd shims', () => {
  assert.deepEqual(
    resolveMuseTarget({}, { command: 'C:\\x\\muse.exe' }),
    { exe: 'C:\\x\\muse.exe', args: [] },
  );
  const sibling = resolveMuseTarget({}, {
    command: 'C:\\x\\muse.cmd',
    readdirSync: () => ['muse-bin-1.4.9-R1.1.exe', 'muse-bin-1.4.11-R6667.1.exe', 'muse.cmd'],
  });
  assert.deepEqual(sibling, { exe: path.join('C:\\x', 'muse-bin-1.4.11-R6667.1.exe'), args: [] });
  const wrapped = resolveMuseTarget({}, {
    command: 'C:\\x\\muse.cmd',
    readdirSync: () => { throw new Error('missing'); },
  });
  assert.equal(wrapped.exe, 'cmd.exe');
  assert.deepEqual(wrapped.args, ['/d', '/s', '/c', '"C:\\x\\muse.cmd" serve --no-session-log']);
  assert.equal(resolveMuseTarget({}, { command: null, installDir: null }), null);
});
