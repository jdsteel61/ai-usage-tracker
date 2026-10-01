'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchClaudeUsage } = require('../src/main/claudeWatcher');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await pause(20);
  assert.ok(predicate(), 'watcher notified within three seconds');
}

test('Claude watcher: detects missing-file creation and atomic replacement, then stops', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aitracker-watcher-'));
  const filePath = path.join(directory, 'usage.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const contents = [];
  const stop = watchClaudeUsage(filePath, () => {
    contents.push(fs.readFileSync(filePath, 'utf8'));
  }, { intervalMs: 25, debounceMs: 10 });
  t.after(stop);
  await pause(100); // establish the missing-file baseline before creating it
  assert.deepEqual(contents, [], 'initial missing file does not produce a refresh');
  fs.writeFileSync(filePath, 'first');
  await waitFor(() => contents.includes('first'));
  const temporaryPath = path.join(directory, 'new.tmp');
  fs.writeFileSync(temporaryPath, 'replacement');
  fs.renameSync(temporaryPath, filePath);
  await waitFor(() => contents.includes('replacement'));
  stop();
  const stoppedCount = contents.length;
  fs.writeFileSync(filePath, 'after stop');
  await pause(100);
  assert.equal(contents.length, stoppedCount);
});

test('Claude watcher: coalesces changes and cancels pending or late callbacks on stop', async () => {
  let listener;
  let stoppedListener;
  let changes = 0;
  let stopCalls = 0;
  const stop = watchClaudeUsage('fake-usage.json', () => { changes++; }, {
    debounceMs: 20,
    watchFile(filePath, options, callback) {
      assert.equal(filePath, 'fake-usage.json');
      assert.equal(options.persistent, false);
      assert.equal(options.interval, 1000);
      listener = callback;
    },
    unwatchFile(filePath, callback) {
      assert.equal(filePath, 'fake-usage.json');
      stoppedListener = callback;
      stopCalls++;
    },
  });
  const initial = { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0, nlink: 0 };
  const updated = { mtimeMs: 1, ctimeMs: 1, size: 10, ino: 1, nlink: 1 };
  listener(initial, initial);
  listener(updated, initial);
  listener({ ...updated, mtimeMs: 2 }, updated);
  await pause(50);
  assert.equal(changes, 1, 'burst yields one refresh');
  listener(updated, initial);
  stop();
  stop();
  assert.equal(stoppedListener, listener, 'unregisters only its own listener');
  assert.equal(stopCalls, 1, 'stop is idempotent');
  listener(updated, initial);
  await pause(50);
  assert.equal(changes, 1, 'pending and late events do not refresh after stop');
});
