'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatCountdown, formatClock, formatDateTime, formatAge } = require('../src/main/format');

test('countdown formatting across magnitudes', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  assert.equal(formatCountdown(new Date(now + 30_000).toISOString(), now), '<1m');
  assert.equal(formatCountdown(new Date(now + 38 * 60_000).toISOString(), now), '38m');
  assert.equal(formatCountdown(new Date(now + 2 * 3600_000 + 5 * 60_000).toISOString(), now), '2h 05m');
  assert.equal(formatCountdown(new Date(now + 2 * 3600_000).toISOString(), now), '2h');
  assert.equal(formatCountdown(new Date(now + 4 * 86400_000 + 3 * 3600_000).toISOString(), now), '4d 3h');
  assert.equal(formatCountdown(new Date(now + 5 * 86400_000).toISOString(), now), '5d');
  assert.equal(formatCountdown(new Date(now - 9999).toISOString(), now), '<1m');
  assert.equal(formatCountdown('garbage', now), null);
  assert.equal(formatCountdown(null, now), null);
});

test('clock formatting honors 12/24-hour setting', () => {
  const t = '2026-09-21T14:32:00Z';
  assert.equal(formatClock(t, { hour24: true, timeZone: 'UTC' }), '14:32');
  const twelve = formatClock(t, { hour24: false, timeZone: 'UTC' });
  assert.ok(/2:32\sPM/.test(twelve), twelve);
  assert.equal(formatClock('nope', {}), null);
});

test('clock formatting is correct across the US DST spring-forward (2026-03-08)', () => {
  // America/New_York: 2026-03-08 02:00 EST -> 03:00 EDT (jump to UTC-4)
  const zone = 'America/New_York';
  const before = '2026-03-08T06:59:00Z'; // 01:59 EST
  const after = '2026-03-08T07:01:00Z'; // 03:01 EDT (02:xx does not exist locally)
  assert.equal(formatClock(before, { hour24: true, timeZone: zone }), '01:59');
  assert.equal(formatClock(after, { hour24: true, timeZone: zone }), '03:01');
  // A one-hour span across the jump is still shown as two distinct wall times,
  // and the countdown (pure duration) is unaffected:
  const now = Date.parse('2026-03-08T06:30:00Z');
  assert.equal(formatCountdown('2026-03-08T07:30:00Z', now), '1h');
});

test('clock formatting is correct across the US DST fall-back (2026-11-01)', () => {
  const zone = 'America/New_York';
  // The repeated wall-clock hour is 01:00-01:59: once as EDT, once as EST.
  const first130 = '2026-11-01T05:30:00Z'; // 01:30 EDT
  const second130 = '2026-11-01T06:30:00Z'; // 01:30 EST
  assert.equal(formatClock(first130, { hour24: true, timeZone: zone }), '01:30');
  assert.equal(formatClock(second130, { hour24: true, timeZone: zone }), '01:30');
  const dt1 = formatDateTime(first130, { hour24: true, timeZone: zone });
  const dt2 = formatDateTime(second130, { hour24: true, timeZone: zone });
  assert.notEqual(dt1, dt2, 'zone abbreviation disambiguates the repeated hour');
  assert.ok(/EDT/.test(dt1) && /EST/.test(dt2), `${dt1} / ${dt2}`);
});

test('age formatting for stale markers', () => {
  const now = Date.now();
  assert.equal(formatAge(now - 20_000, now), 'just now');
  assert.equal(formatAge(now - 12 * 60_000, now), '12m old');
  assert.equal(formatAge(now - 3 * 3600_000, now), '3h old');
  assert.equal(formatAge(now - 26 * 3600_000, now), '1d old');
  assert.equal(formatAge(null, now), null);
});
