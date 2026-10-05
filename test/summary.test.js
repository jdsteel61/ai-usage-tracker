'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildUsageSummary, resetLabel, readingStatus } = require('../src/renderer/summary');

const NOW = Date.parse('2026-09-22T08:35:00Z'); // Tue
// Expected times must be computed in the machine's local timezone (the
// formatter under test uses Intl, which formats locally).
const t = (iso) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(iso));

function snap(providers, now = NOW) {
  return { now, providers };
}

test('summary: full multi-window provider line', () => {
  const text = buildUsageSummary(snap([{
    id: 'claude', title: 'Claude', enabled: true, ok: true, plan: 'max', stale: false,
    windows: {
      session: { label: '5 hr', usedPercent: 6, resetsAt: '2026-09-22T12:40:00Z' },
      weekly: { label: 'Week', usedPercent: 78, resetsAt: '2026-09-24T15:00:00Z' },
    },
    notes: [],
  }]), { now: NOW });
  const lines = text.split('\n');
  assert.match(lines[0], /^AI usage - /);
  assert.equal(lines[1], `Claude (max): 5 hr 6% (resets ${t('2026-09-22T12:40:00Z')}); Week 78% (resets Thu ${t('2026-09-24T15:00:00Z')})`);
});

test('summary: credit window without reset says so', () => {
  const text = buildUsageSummary(snap([{
    id: 'openrouter', title: 'OpenRouter', enabled: true, ok: true, plan: null, stale: false,
    windows: { session: null, weekly: { label: 'Credits', usedPercent: 63, resetsAt: null } },
    notes: ['Rate limit: 20 req/10s'],
  }]), { now: NOW });
  assert.ok(text.includes('OpenRouter: Credits 63% (does not reset)'));
});

test('summary: window-less provider falls back to notes; failing provider shows code', () => {
  const text = buildUsageSummary(snap([
    {
      id: 'gemini', title: 'Gemini', enabled: true, ok: true, plan: 'AI Studio', stale: false,
      windows: { session: null, weekly: null }, notes: ['Key valid - Google exposes no usage/quota API'],
    },
    { id: 'grok', title: 'Grok', enabled: true, ok: false, error: { code: 'NO_KEY', message: 'x' }, windows: { session: null, weekly: null }, notes: [] },
  ]), { now: NOW });
  assert.ok(text.includes('Gemini (AI Studio): Key valid - Google exposes no usage/quota API'));
  assert.ok(text.includes('Grok: unavailable (NO_KEY)'));
});

test('summary: stale flag and disabled providers', () => {
  const text = buildUsageSummary(snap([
    { id: 'codex', title: 'Codex', enabled: true, ok: true, stale: true, plan: null,
      windows: { session: null, weekly: { label: 'Week', usedPercent: 34, resetsAt: '2026-09-28T15:00:00Z' } }, notes: [] },
    { id: 'zai', title: 'Z.ai', enabled: false, ok: false, windows: { session: null, weekly: null }, notes: [] },
  ]), { now: NOW });
  assert.ok(text.includes(`Codex: Week 34% (resets Mon ${t('2026-09-28T15:00:00Z')}) [stale]`));
  assert.ok(!text.includes('Z.ai'));
});

test('summary: invalid input yields empty string', () => {
  assert.equal(buildUsageSummary(null), '');
  assert.equal(buildUsageSummary({}), '');
});

test('summary: old local account includes the reading age and expired resets', () => {
  const text = buildUsageSummary(snap([{
    title: 'Claude Work', ok: true, stale: true, fetchedAt: NOW - 95 * 60_000,
    source: 'claude-statusline',
    windows: { session: { label: '5 hr', usedPercent: 20, resetsAt: '2026-09-22T08:00:00Z' } },
  }]), { now: NOW });
  assert.match(text, /reset passed/);
  assert.doesNotMatch(text, /\(resets /);
  assert.match(text, /\[stale; local Claude Code reading; reading 1h 35m old\]/);
});

test('summary: cached and unavailable cooldowns include the next retry', () => {
  const retryAt = NOW + 30 * 60_000;
  const text = buildUsageSummary(snap([
    { title: 'Codex', ok: true, stale: true, fetchedAt: NOW - 12 * 60_000,
      error: { code: 'RATE_LIMITED', retryAt }, windows: { weekly: { label: 'Week', usedPercent: 34, resetsAt: null } } },
    { title: 'Z.ai', ok: false, error: { code: 'RATE_LIMITED', retryAt } },
  ]), { now: NOW });
  assert.ok(text.includes(`[stale; reading 12m old; cooldown; next retry ${t(retryAt)}]`));
  assert.ok(text.includes(`Z.ai: unavailable (RATE_LIMITED) [cooldown; next retry ${t(retryAt)}]`));
});

test('summary: local fresh reading includes age without stale flag', () => {
  const text = buildUsageSummary(snap([{
    title: 'Claude', ok: true, fetchedAt: NOW - 30_000,
    notes: ['From Claude Code status line'],
    windows: { session: { label: '5 hr', usedPercent: 4, resetsAt: null } },
  }]), { now: NOW });
  assert.match(text, /\[local Claude Code reading; reading just now\]/);
  assert.doesNotMatch(text, /stale/);
});

test('summary: Claude API reading is labeled and unreadable accounts invent no age', () => {
  const api = buildUsageSummary(snap([{ title: 'Claude', ok: true, fetchedAt: NOW - 12 * 60_000, source: 'claude-api',
    windows: { session: { label: '5 hr', usedPercent: 4, resetsAt: null } } }]), { now: NOW });
  assert.match(api, /\[Claude usage API reading; reading 12m old\]/);
  const none = buildUsageSummary(snap([{ title: 'Claude Work', ok: false, error: { code: 'NO_DATA' } }]), { now: NOW });
  assert.ok(none.includes('unavailable (NO_DATA)'));
  assert.doesNotMatch(none, /reading|old/);
});

test('summary: resetLabel weekday boundary', () => {
  assert.equal(resetLabel('2026-09-22T10:00:00Z', NOW, true), t('2026-09-22T10:00:00Z')); // < 24h: time only
  assert.equal(resetLabel('2026-09-25T15:00:00Z', NOW, true), `Fri ${t('2026-09-25T15:00:00Z')}`); // >= 24h: weekday + time
  assert.equal(resetLabel('junk', NOW, true), null);
});

test('reading state: current readings include source and age; metadata-only success stays honest', () => {
  const status = readingStatus({ id: 'gemini', ok: true, fetchedAt: NOW - 30_000, windows: {} }, { now: NOW });
  assert.equal(status.state, 'current');
  assert.match(status.detail, /last provider check succeeded/);
  assert.match(status.detail, /Reading age: just now/);
  assert.doesNotMatch(status.detail, /quota.*current/i);
});

test('reading state: elapsed time changes freshness without a new snapshot', () => {
  const local = { id: 'claude', ok: true, fetchedAt: NOW, windows: {} };
  assert.equal(readingStatus(local, { now: NOW + 15 * 60_000 }).state, 'current');
  assert.equal(readingStatus(local, { now: NOW + 15 * 60_000 + 1 }).state, 'cached');
  const remote = { ...local, id: 'codex' };
  assert.equal(readingStatus(remote, { now: NOW + 2 * 60_000, intervalMinutes: 1 }).state, 'current');
  assert.equal(readingStatus(remote, { now: NOW + 2 * 60_000 + 1, intervalMinutes: 1 }).state, 'cached');
});

test('reading state: restored readings, expired windows and rate limits show cached values', () => {
  const restored = { id: 'codex', ok: true, stale: true, fetchedAt: NOW, windows: {} };
  assert.equal(readingStatus(restored, { now: NOW }).state, 'cached');
  const status = readingStatus({ ...restored, stale: false,
    windows: { session: { resetsAt: new Date(NOW).toISOString() } },
    error: { code: 'HTTP_429', retryAt: NOW + 60_000 } }, { now: NOW });
  assert.equal(status.state, 'cached');
  assert.match(status.detail, /previous window/);
  assert.match(status.detail, /next retry/);
  assert.match(status.detail, /Refresh respects this pause/);
});

test('reading state: Claude is never paused; missing values have no age; API readings last longer', () => {
  const waiting = readingStatus({ id: 'claude-profile-work', ok: false,
    error: { code: 'NO_DATA' }, fetchedAt: NOW }, { now: NOW });
  assert.equal(waiting.state, 'waiting');
  assert.doesNotMatch(waiting.detail, /Reading age/);
  assert.equal(readingStatus({ id: 'claude', ok: true, stale: true }, { now: NOW }).state, 'cached');
  const api = { id: 'claude', ok: true, fetchedAt: NOW, source: 'claude-api', windows: {} };
  assert.equal(readingStatus(api, { now: NOW + 35 * 60_000 }).state, 'current');
  assert.equal(readingStatus(api, { now: NOW + 35 * 60_000 + 1 }).state, 'cached');
  assert.match(readingStatus(api, { now: NOW }).detail, /Source: Claude usage API/);
});

test('source label: local is live when fresh; ages and API source are spelled out', () => {
  const { sourceLabel } = require('../src/renderer/summary');
  const local = { source: 'claude-statusline', fetchedAt: NOW - 30_000 };
  assert.equal(sourceLabel(local, NOW), 'local \u00b7 live');
  assert.equal(sourceLabel({ ...local, fetchedAt: NOW - 7 * 60_000 }, NOW), 'local \u00b7 7 min ago');
  assert.equal(sourceLabel({ notes: ['From Claude usage API'], fetchedAt: NOW - 12 * 60_000 }, NOW), 'api \u00b7 12 min ago');
  assert.equal(sourceLabel({ source: 'claude-api', fetchedAt: NOW - 95 * 60_000 }, NOW), 'api \u00b7 1 h 35 min ago');
});

test('summary: current remote readings include age and age into stale at copy time', () => {
  const view = snap([{ id: 'codex', title: 'Codex', ok: true, fetchedAt: NOW,
    windows: { weekly: { label: 'Week', usedPercent: 20, resetsAt: null } } }]);
  assert.match(buildUsageSummary(view, { now: NOW }), /\[reading just now\]/);
  assert.match(buildUsageSummary(view, { now: NOW + 3 * 60_000, intervalMinutes: 1 }), /\[stale; reading 3m old\]/);
});

test('summary: Claude model-specific weekly limits appear in the line and hover detail only', () => {
  const p = {
    id: 'claude', title: 'Claude', enabled: true, ok: true, plan: 'max', stale: false, fetchedAt: NOW, source: 'claude-api',
    windows: {
      session: { label: '5 hr', usedPercent: 3, resetsAt: '2026-09-22T12:40:00Z' },
      weekly: { label: 'Week', usedPercent: 1, resetsAt: '2026-09-24T15:00:00Z' },
    },
    extras: [
      { id: 'claude:model:fable', kind: 'other', label: 'Fable', usedPercent: 0, resetsAt: '2026-09-27T01:00:00Z' },
      { id: 'claude:model:old', kind: 'other', label: 'Old', usedPercent: 50, resetsAt: '2026-09-21T01:00:00Z' },
      { id: 'claude:model:evil', kind: 'other', label: 'Ev<b>il\nline', usedPercent: 12.4, resetsAt: '2026-09-27T01:00:00Z' },
      { id: 'zai:web', kind: 'other', label: 'Web', usedPercent: 5, resetsAt: '2026-09-27T01:00:00Z' },
    ],
    notes: ['From Claude usage API'],
  };
  const line = buildUsageSummary(snap([p]), { now: NOW }).split('\n');
  assert.equal(line.length, 2);
  assert.match(line[1], /; Fable week 0%; Ev b il line week 12%/);
  assert.ok(!line[1].includes('Old') && !line[1].includes('Web'));
  const detail = readingStatus(p, { now: NOW }).detail;
  assert.match(detail, /Model weekly limits:\n {2}Fable 0% used \(resets /);
  assert.ok(!detail.includes('<'));
  const plain = buildUsageSummary(snap([{ ...p, extras: [] }]), { now: NOW });
  assert.ok(!plain.includes('week 0%'));
});
