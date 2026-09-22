'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildUsageSummary, resetLabel } = require('../src/renderer/summary');

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

test('summary: resetLabel weekday boundary', () => {
  assert.equal(resetLabel('2026-09-22T10:00:00Z', NOW, true), t('2026-09-22T10:00:00Z')); // < 24h: time only
  assert.equal(resetLabel('2026-09-25T15:00:00Z', NOW, true), `Fri ${t('2026-09-25T15:00:00Z')}`); // >= 24h: weekday + time
  assert.equal(resetLabel('junk', NOW, true), null);
});
