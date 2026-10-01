'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { captureUsage, usagePath, installCapture } = require('../src/main/claudeStatusline');
const { fetchClaudeQuotas } = require('../src/main/providers/claude');
const { mergeWithCache } = require('../src/main/providers');

function tempProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('capture preserves missing windows and timestamps without saving session data', (t) => {
  const dir = tempProfile(t);
  const now = Date.now();
  const data = { rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: (now + 3600_000) / 1000 },
    seven_day: { used_percentage: 41, resets_at: (now + 604800_000) / 1000 },
  }, transcript_path: 'private-transcript', session_id: 'private-id', accessToken: 'private-token' };
  assert.equal(captureUsage(data, dir, now), true);
  assert.equal(captureUsage({}, dir, now + 1000), false);
  const saved = fs.readFileSync(usagePath(dir), 'utf8');
  assert.equal(saved.includes('private-'), false);
  assert.equal(JSON.parse(saved).windows.five_hour.observedAt, now);
  captureUsage({ rate_limits: { seven_day: { used_percentage: 42, resets_at: (now + 604800_000) / 1000 } } }, dir, now + 2000);
  const updated = JSON.parse(fs.readFileSync(usagePath(dir), 'utf8'));
  assert.equal(updated.windows.five_hour.observedAt, now);
  assert.equal(updated.windows.seven_day.usedPercent, 42);
});

test('profiles are isolated and cached status-line age remains stale after merging', async (t) => {
  const dir = tempProfile(t);
  const other = tempProfile(t);
  const now = Date.now();
  captureUsage({ rate_limits: { five_hour: { used_percentage: 25, resets_at: (now + 3600_000) / 1000 } } }, dir, now);
  assert.equal((await fetchClaudeQuotas({ configDir: other })).error.code, 'NO_DATA');
  const snap = await fetchClaudeQuotas({ configDir: dir, now: () => now + 20 * 60_000 });
  assert.equal(mergeWithCache({ claude: snap }).claude.stale, true);
  assert.equal(snap.fetchedAt, now);
});

test('installed wrapper preserves prior stdout and stdin and reinstall does not nest wrappers', (t) => {
  const dir = tempProfile(t);
  const prior = path.join(dir, 'prior.cjs');
  fs.writeFileSync(prior, "process.stdout.write('existing:' + JSON.parse(require('fs').readFileSync(0, 'utf8')).model.display_name);");
  const command = `node "${prior.replace(/\\/g, '/')}"`;
  const original = { statusLine: { type: 'command', command, padding: 2 }, theme: 'dark' };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(original));
  installCapture(dir);
  installCapture(dir);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.statusLine.padding, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ai-usage-tracker', 'original-statusline.json'), 'utf8')), original.statusLine);
  const now = Date.now();
  const result = spawnSync(process.execPath, [path.join(dir, 'ai-usage-tracker', 'collector.cjs'), dir], {
    input: JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: {
      five_hour: { used_percentage: 12, resets_at: (now + 3600_000) / 1000 },
    } }), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'existing:Opus');
  assert.equal(JSON.parse(fs.readFileSync(usagePath(dir), 'utf8')).windows.five_hour.usedPercent, 12);
});
