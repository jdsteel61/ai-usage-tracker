'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeCodexResult, windowKindForDuration, resetToIso } = require('../src/main/providers/codex');
const { normalizeClaudeUsage, readClaudeAuth } = require('../src/main/providers/claude');
const { normalizeZaiQuota, limitPeriodSeconds } = require('../src/main/providers/zai');
const { clampPercent, findWindow } = require('../src/main/providers/model');

const FIX = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// ---------------------------------------------------------------- Codex

test('codex: normalizes representative rate-limit payload', () => {
  const snap = normalizeCodexResult(FIX('codex-ratelimits.json'));
  assert.equal(snap.ok, true);
  assert.equal(snap.providerId, 'codex');
  assert.equal(snap.plan, 'pro');
  const session = findWindow(snap, 'session');
  const weekly = findWindow(snap, 'weekly');
  assert.ok(session, 'session window present');
  assert.ok(weekly, 'weekly window present');
  assert.equal(session.usedPercent, 72.4);
  assert.equal(session.periodSeconds, 18000);
  assert.equal(session.label, '5 hr');
  assert.equal(weekly.usedPercent, 34.2);
  assert.equal(weekly.label, 'Week');
  // resetsAt arrives as epoch seconds
  assert.equal(session.resetsAt, new Date(1758456000 * 1000).toISOString());
});

test('codex: missing windows yield no invented values', () => {
  const snap = normalizeCodexResult({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, windowDurationMins: 300 } } } });
  assert.equal(findWindow(snap, 'weekly'), undefined);
  assert.ok(snap.notes.some((n) => /no subscription windows/i.test(n)) === false || findWindow(snap, 'session'));
});

test('codex: additional unknown windows are classified as other, not guessed', () => {
  const snap = normalizeCodexResult({
    rateLimitsByLimitId: {
      a: { primary: { usedPercent: 10, resetsAt: 100, windowDurationMins: 1440 } }, // daily -> other
      b: { secondary: { usedPercent: 20, resetsAt: 200, windowDurationMins: 43200 } }, // 30d -> other
    },
  });
  assert.equal(findWindow(snap, 'session'), undefined);
  assert.equal(findWindow(snap, 'weekly'), undefined);
  assert.equal(snap.windows.every((w) => w.kind === 'other'), true);
  assert.equal(snap.windows.length, 2);
});

test('codex: malformed entries are skipped, not fatal', () => {
  const snap = normalizeCodexResult({ rateLimitsByLimitId: { junk: null, x: { primary: 'not-an-object' }, ok: { primary: { usedPercent: 5, resetsAt: 1, windowDurationMins: 300 } } } });
  assert.equal(snap.ok, true);
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].kind, 'session');
});

test('codex: API-key plan is noted, not hidden', () => {
  const snap = normalizeCodexResult({ rateLimitsByLimitId: { codex: { planType: 'api-key-user', primary: { usedPercent: 1, resetsAt: 5, windowDurationMins: 300 } } } });
  assert.ok(snap.notes.some((n) => /API-key/i.test(n)));
});

test('codex: window kind and label helpers', () => {
  assert.equal(windowKindForDuration(300), 'session');
  assert.equal(windowKindForDuration(10080), 'weekly');
  assert.equal(windowKindForDuration(1440), 'other');
  assert.equal(windowKindForDuration(0), 'other');
  assert.equal(resetToIso(0), null);
  assert.equal(resetToIso(-5), null);
  assert.equal(resetToIso('x'), null);
});

// Codex spawn resolution: Node on Windows refuses to spawn npm .cmd shims
// directly (spawn EINVAL). The adapter must resolve the shim to its real
// target: node.exe + codex.js.
test('codex: parseShimTarget extracts node.exe + codex.js from an npm .cmd shim', () => {
  const { parseShimTarget } = require('../src/main/providers/codex');
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    ':start',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n');
  const readFile = () => shim;
  const exists = (p) => p.endsWith('node.exe');
  const target = parseShimTarget('C:\\tools\\node\\codex.cmd', readFile, exists);
  assert.deepEqual(target, {
    exe: 'C:\\tools\\node\\node.exe',
    args: ['C:\\tools\\node\\node_modules\\@openai\\codex\\bin\\codex.js'],
  });
});

test('codex: parseShimTarget falls back to PATH node when no sibling node.exe', () => {
  const { parseShimTarget } = require('../src/main/providers/codex');
  const target = parseShimTarget('C:\\shims\\codex.cmd', () => '"%dp0%\\x.js"', () => false);
  assert.deepEqual(target, { exe: 'node', args: ['C:\\shims\\x.js'] });
});

test('codex: resolveCodexTarget prefers .exe, falls back to cmd.exe for unparsable shims', () => {
  const { resolveCodexTarget } = require('../src/main/providers/codex');
  assert.deepEqual(
    resolveCodexTarget({}, { command: 'C:\\x\\codex.exe' }),
    { exe: 'C:\\x\\codex.exe', args: [] },
  );
  const fallback = resolveCodexTarget({}, {
    command: 'C:\\x\\codex.cmd',
    readFileSync: () => { throw new Error('unreadable'); },
  });
  assert.equal(fallback.exe, 'cmd.exe');
  assert.deepEqual(fallback.args, ['/d', '/s', '/c', '"C:\\x\\codex.cmd" app-server']);
  assert.equal(resolveCodexTarget({}, { command: null }), null);
});

// ---------------------------------------------------------------- Claude

test('claude: normalizes five-hour, weekly, and scoped model windows', () => {
  const snap = normalizeClaudeUsage(FIX('claude-usage.json'), { subscriptionType: 'max' });
  assert.equal(snap.ok, true);
  assert.equal(snap.plan, 'max');
  const session = findWindow(snap, 'session');
  const weekly = findWindow(snap, 'weekly');
  assert.equal(session.usedPercent, 91);
  assert.equal(session.resetsAt, '2026-09-21T18:30:00.000Z');
  assert.equal(weekly.usedPercent, 58);
  const opus = snap.windows.find((w) => w.label === 'Opus');
  assert.ok(opus, 'scoped model limit normalized');
  assert.equal(opus.kind, 'other');
  assert.equal(opus.usedPercent, 42);
});

test('claude: usage-based billing yields an explanatory note, no invented windows', () => {
  const snap = normalizeClaudeUsage({}, { subscriptionType: null });
  assert.equal(snap.windows.length, 0);
  assert.ok(snap.notes.some((n) => /usage-based API billing/i.test(n)));
});

test('claude: malformed utilization values are rejected, not clamped from garbage', () => {
  const snap = normalizeClaudeUsage({ five_hour: { utilization: 'high' }, seven_day: { utilization: null } }, {});
  assert.equal(snap.windows.length, 0);
});

test('claude: credential read handles absent and corrupt files without throwing', () => {
  assert.equal(readClaudeAuth({ credentialsPath: path.join(__dirname, 'fixtures', 'definitely-absent.json') }), null);
  const tmp = path.join(__dirname, 'tmp-corrupt.json');
  fs.writeFileSync(tmp, '{not json');
  const corrupt = readClaudeAuth({ credentialsPath: tmp });
  assert.deepEqual(corrupt, { corrupt: true });
  fs.unlinkSync(tmp);
});

// ---------------------------------------------------------------- Z.ai

test('zai: classifies token limits by unit codes and maps web searches', () => {
  const snap = normalizeZaiQuota(FIX('zai-quota.json'));
  assert.equal(snap.ok, true);
  assert.equal(snap.plan, 'pro');
  const session = findWindow(snap, 'session');
  const weekly = findWindow(snap, 'weekly');
  assert.equal(session.usedPercent, 24);
  assert.equal(session.periodSeconds, 5 * 3600);
  assert.equal(weekly.usedPercent, 12);
  assert.equal(weekly.periodSeconds, 7 * 24 * 3600);
  const searches = snap.windows.find((w) => w.id === 'zai:webSearches');
  assert.ok(searches, 'web-search limit normalized');
  assert.equal(searches.usedPercent, 35);
  assert.equal(searches.kind, 'other');
});

test('zai: unit code table', () => {
  assert.equal(limitPeriodSeconds({ unit: 3, number: 5 }), 18000);
  assert.equal(limitPeriodSeconds({ unit: 4, number: 2 }), 172800);
  assert.equal(limitPeriodSeconds({ unit: 5, number: 1 }), 30 * 86400);
  assert.equal(limitPeriodSeconds({ unit: 6, number: 1 }), 604800);
  assert.equal(limitPeriodSeconds({ unit: 99, number: 1 }), null);
  assert.equal(limitPeriodSeconds({ unit: 3, number: 0 }), null);
});

test('zai: CREDIT_LIMIT entries (credit-based Coding Plans) map like TOKENS_LIMIT', () => {
  const snap = normalizeZaiQuota({
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 41, nextResetTime: 1789348800000 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 12, nextResetTime: 1789867200000 },
      ],
      level: 'max',
    },
    success: true,
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.plan, 'max');
  const session = findWindow(snap, 'session');
  const weekly = findWindow(snap, 'weekly');
  assert.ok(session, '5-hour credit window recognized');
  assert.equal(session.usedPercent, 41);
  assert.ok(weekly, 'weekly credit window recognized');
  assert.equal(weekly.usedPercent, 12);
  assert.equal(snap.notes.length, 0, 'no diagnostic note when windows are recognized');
});

test('zai: no recognizable limits produces a sanitized descriptor note', () => {
  const snap = normalizeZaiQuota({ data: { limits: [{ type: 'MYSTERY', unit: 3, number: 5 }], level: 'x' } });
  assert.equal(snap.windows.length, 0);
  assert.ok(snap.notes.some((n) => /MYSTERY\(unit=3x5\)/.test(n)), snap.notes.join(';'));
});

test('zai: no-coding-plan envelope becomes a note', () => {
  const snap = normalizeZaiQuota({ success: false, msg: 'You do not have a Coding Plan' });
  assert.equal(snap.ok, true);
  assert.equal(snap.windows.length, 0);
  assert.ok(snap.notes.some((n) => /No Z.ai Coding Plan/i.test(n)));
});

test('zai: malformed payloads throw structured errors for the transport layer', () => {
  assert.throws(() => normalizeZaiQuota(null), /invalid payload/);
  assert.throws(() => normalizeZaiQuota({ data: { limits: 'nope' } }), /invalid payload/);
});

test('zai: unknown limit entries are ignored rather than guessed', () => {
  const snap = normalizeZaiQuota({ data: { limits: [{ type: 'MYSTERY_LIMIT', percentage: 50 }], level: 'lite' } });
  assert.equal(snap.windows.length, 0);
  assert.equal(snap.plan, 'lite');
});

// ---------------------------------------------------------------- shared

test('percent clamping and unknown handling', () => {
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(250), 100);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(NaN), null);
  assert.equal(clampPercent('72'), null);
  assert.equal(clampPercent(null), null);
});
