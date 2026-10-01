'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { captureUsage, usagePath, installCapture, restoreCapture } = require('../src/main/claudeStatusline');
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

test('undo restores only the status line, keeps later settings and cached data, and is idempotent', (t) => {
  const dir = tempProfile(t);
  const file = path.join(dir, 'settings.json');
  const original = { type: 'command', command: 'echo existing', padding: 2 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: original, theme: 'dark' }));
  installCapture(dir);
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...installed, theme: 'light', permissions: { allow: ['Read'] } }));
  const now = Date.now();
  captureUsage({ rate_limits: { five_hour: { used_percentage: 23, resets_at: (now + 3600_000) / 1000 } } }, dir, now);
  const usage = fs.readFileSync(usagePath(dir), 'utf8');
  assert.deepEqual(restoreCapture(dir), { ok: true, alreadyDisabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    statusLine: original, theme: 'light', permissions: { allow: ['Read'] },
  });
  assert.equal(fs.readFileSync(usagePath(dir), 'utf8'), usage);
  assert.equal(fs.existsSync(path.join(dir, 'ai-usage-tracker', 'collector.cjs')), true);
  const restored = fs.readFileSync(file, 'utf8');
  assert.deepEqual(restoreCapture(dir), { ok: true, alreadyDisabled: true });
  assert.equal(fs.readFileSync(file, 'utf8'), restored);
  installCapture(dir);
  restoreCapture(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, original);
});

test('undo preserves the difference between an absent status line and an explicit null', (t) => {
  for (const original of [{ theme: 'dark' }, { theme: 'dark', statusLine: null }]) {
    const dir = tempProfile(t);
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(original));
    installCapture(dir);
    restoreCapture(dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
    assert.equal(restoreCapture(dir).alreadyDisabled, true);
  }
});

test('undo refuses changed status-line commands and options without overwriting any settings', (t) => {
  for (const change of [{ command: 'echo newly configured' }, { padding: 4 }]) {
    const dir = tempProfile(t);
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'echo before', padding: 2 } }));
    installCapture(dir);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...settings, statusLine: { ...settings.statusLine, ...change } }));
    const changed = fs.readFileSync(file, 'utf8');
    assert.throws(() => restoreCapture(dir), /status line changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), changed);
  }
});

test('undo supports legacy installations that saved only the original field', (t) => {
  for (const original of [null, { type: 'command', command: 'echo old', padding: 3 }]) {
    const dir = tempProfile(t);
    const file = path.join(dir, 'settings.json');
    const collector = path.join(dir, 'ai-usage-tracker', 'collector.cjs').replace(/\\/g, '/');
    const command = `node "${collector}" "${dir.replace(/\\/g, '/')}"`;
    fs.mkdirSync(path.join(dir, 'ai-usage-tracker'));
    fs.writeFileSync(path.join(dir, 'ai-usage-tracker', 'original-statusline.json'), JSON.stringify(original));
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', statusLine: { ...(original || {}), type: 'command', command } }));
    assert.equal(restoreCapture(dir).ok, true);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(settings.theme, 'dark');
    if (original === null) assert.equal(Object.hasOwn(settings, 'statusLine'), false);
    else assert.deepEqual(settings.statusLine, original);
  }
});

test('undo refuses missing or invalid recovery files and leaves the installed settings intact', (t) => {
  for (const [name, contents] of [['original-statusline.json', null], ['original-statusline.json', '{broken'],
    ['original-statusline.json', '[]'], ['capture-state.json', '{}']]) {
    const dir = tempProfile(t);
    installCapture(dir);
    const file = path.join(dir, 'settings.json');
    const installed = fs.readFileSync(file, 'utf8');
    const recovery = path.join(dir, 'ai-usage-tracker', name);
    if (contents === null) fs.unlinkSync(recovery);
    else fs.writeFileSync(recovery, contents);
    assert.throws(() => restoreCapture(dir), /Cannot restore capture/);
    assert.equal(fs.readFileSync(file, 'utf8'), installed);
  }
});

test('undo on an untouched profile creates no files and malformed settings are rejected', (t) => {
  const dir = tempProfile(t);
  assert.equal(restoreCapture(dir).alreadyDisabled, true);
  assert.deepEqual(fs.readdirSync(dir), []);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'broken');
  assert.throws(() => restoreCapture(dir), /valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
