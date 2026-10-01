'use strict';
/* global AbortController */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DEFAULTS } = require('../src/main/settings');
const { HistoryStore } = require('../src/main/history');
const providers = require('../src/main/providers');

const mainPath = path.resolve(__dirname, '../src/main/main.js');
const mainRequire = createRequire(mainPath);
const WORK = 'claude-profile-work';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function reading(id, percent, fetchedAt = Date.now()) {
  return { providerId: id, ok: true, fetchedAt,
    notes: id.startsWith('claude') ? ['From Claude Code status line'] : [],
    windows: [{ kind: 'session', label: '5 hr', usedPercent: percent,
      resetsAt: new Date(fetchedAt + 3_600_000).toISOString() }] };
}

/** Run the actual main-process functions with an unsuccessful instance lock.
 * That skips app startup naturally. All account reads, polls, watches, and
 * cache writes are mocked; history and snapshot shaping use production code. */
function harness({ poll = async () => ({}), local = () => reading('claude', 10), confirmResponse = 0, demo = false } = {}) {
  const handles = new Map();
  const watchers = [];
  const saves = [];
  const gauges = [];
  const tips = [];
  const warnings = [];
  const dialogs = [];
  const captureChanges = [];
  const credentialAttempts = [];
  const loginChanges = [];
  let refreshCount = 0;
  let pollCount = 0;
  let state = { ...DEFAULTS, providers: { ...DEFAULTS.providers },
    claudeProfiles: [{ id: WORK, label: 'Claude Work', configDir: 'C:/fake/work' }], codexProfiles: [] };
  const history = new HistoryStore('not-written');
  history.save = () => {};
  const settings = { get: () => state, patch: (partial) => (state = { ...state, ...partial }) };
  const tray = { setImage: () => {}, setContextMenu: () => {}, setToolTip: (text) => tips.push(text) };
  const mocks = {
    electron: { app: { requestSingleInstanceLock: () => false, quit: () => {},
      setLoginItemSettings: (options) => { loginChanges.push(options); throw new Error('Unexpected login settings change'); } },
      ipcMain: { handle: (id, handler) => handles.set(id, handler), on: () => {} },
      dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: confirmResponse }; } },
      nativeTheme: {}, nativeImage: { createFromBuffer: (v) => v }, Menu: { buildFromTemplate: (v) => v } },
    './credentials': { TARGET: 'synthetic-zai-target',
      ...Object.fromEntries(['secretExists', 'readSecret', 'writeSecret', 'deleteSecret'].map((action) => [action, () => {
        credentialAttempts.push(action); throw new Error('Unexpected credential access');
      }])),
    },
    './providers': { ...providers, pollAll: async (...args) => { pollCount++; return poll(...args); } },
    './providers/claude': { fetchClaudeQuotas: async (deps) => local(deps) },
    './claudeStatusline': { ...mainRequire('./claudeStatusline'),
      installCapture: (dir) => { captureChanges.push(['enable', dir]); return { ok: true }; },
      restoreCapture: (dir) => { captureChanges.push(['undo', dir]); return { ok: true, alreadyDisabled: false }; },
    },
    './claudeWatcher': { watchClaudeUsage: (file, update) => {
      const watch = { file, update, stopped: false };
      watchers.push(watch);
      return () => { watch.stopped = true; };
    } },
    './readingCache': { loadReadings: () => ({}), saveReadings: (...args) => saves.push(args) },
    './icon': { drawGauge: (_size, fill) => { gauges.push(fill); return Buffer.alloc(0); } },
  };
  const context = vm.createContext({
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : mainRequire(id),
    __dirname: path.dirname(mainPath), process: { env: demo ? { AITRACKER_DEMO: '1' } : {}, argv: [], cwd: () => 'C:/fake' },
    setTimeout, clearTimeout, Buffer, injected: { settings, history, tray,
      log: { debug: () => {}, info: () => {}, warn: (...args) => warnings.push(args), error: () => {} },
      scheduler: { refreshNow: () => { refreshCount++; }, start: () => {} } },
  });
  const source = fs.readFileSync(mainPath, 'utf8');
  vm.runInContext(`${source}\nsettings = injected.settings; history = injected.history;
    tray = injected.tray; log = injected.log; scheduler = injected.scheduler;
    readingsPath = 'C:/fake/readings.json';
    globalThis.hooks = { registerIpc, configureClaudeWatcher, pollProvidersOnce, applyLoginItemSettings,
      applyFreshReadings, updateTrayFromSnapshot,
      getMerged: () => lastMerged, setMerged: (v) => { lastMerged = v; } };`, context);
  return { ...context.hooks, settings, handles, watchers, saves, gauges, tips, warnings, history, dialogs, captureChanges,
    credentialAttempts, loginChanges,
    refreshCount: () => refreshCount, pollCount: () => pollCount };
}

test('main: Claude capture cancellation performs no local changes', async () => {
  const app = harness();
  app.registerIpc();
  for (const action of ['enableCapture', 'restoreCapture']) {
    const result = await app.handles.get(`claude:${action}`)({}, WORK);
    assert.equal(result.canceled, true);
    assert.equal(result.ok, false);
  }
  assert.equal(app.captureChanges.length, 0);
  assert.equal(app.watchers.length, 0);
  assert.equal(app.dialogs.length, 2);
  for (const dialog of app.dialogs) {
    assert.equal(dialog.defaultId, 0);
    assert.equal(dialog.cancelId, 0);
    assert.match(dialog.detail, /C:\/fake\/work/);
    assert.match(dialog.detail, /original-statusline.json/);
  }
});

test('main: confirmed Claude capture operations affect only the chosen config folder', async () => {
  const app = harness({ confirmResponse: 1 });
  app.registerIpc();
  assert.equal((await app.handles.get('claude:enableCapture')({}, WORK)).ok, true);
  assert.equal((await app.handles.get('claude:restoreCapture')({}, WORK)).ok, true);
  await flush();
  assert.deepEqual(app.captureChanges, [['enable', 'C:/fake/work'], ['undo', 'C:/fake/work']]);
  assert.match(app.dialogs[1].detail, /restores only the previous statusLine field/);
  assert.equal(app.pollCount(), 0);
  assert.equal(app.refreshCount(), 0);
});

test('main: unknown profiles and demo mode cannot modify Claude capture', async () => {
  for (const [app, profile] of [[harness({ confirmResponse: 1 }), 'claude-profile-missing'],
    [harness({ confirmResponse: 1, demo: true }), 'claude']]) {
    app.registerIpc();
    for (const action of ['enableCapture', 'restoreCapture']) {
      assert.equal((await app.handles.get(`claude:${action}`)({}, profile)).ok, false);
    }
    assert.equal(app.captureChanges.length, 0);
    assert.equal(app.dialogs.length, 0);
  }
});

test('main: demo Settings cannot access credentials, query key providers, or change Windows startup', async () => {
  const app = harness({ demo: true, confirmResponse: 1 });
  app.registerIpc();
  for (const provider of ['zai', 'grok', 'gemini', 'openrouter']) {
    assert.equal(await app.handles.get('provider:keyExists')({}, provider), false);
    for (const action of ['saveKey', 'testKey', 'removeKey']) {
      const result = await app.handles.get(`provider:${action}`)({}, provider, 'synthetic-demo-key');
      assert.equal(result.ok, false);
      assert.match(result.error, /disabled in demo mode/);
    }
  }
  assert.equal(await app.handles.get('zai:keyExists')({}), false);
  for (const action of ['saveKey', 'testKey', 'removeKey']) {
    const result = await app.handles.get(`zai:${action}`)({}, 'synthetic-demo-key');
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled in demo mode/);
  }
  app.applyLoginItemSettings();
  app.handles.get('launch-at-login')({}, true);
  app.handles.get('settings:patch')({}, { launchAtLogin: false });
  assert.deepEqual(app.credentialAttempts, []);
  assert.deepEqual(app.loginChanges, []);
  assert.deepEqual(app.dialogs, []);
  assert.equal(app.pollCount(), 0);
});

test('main: selecting another Claude account changes only the local watcher', async () => {
  const readDirs = [];
  const app = harness({ local: ({ configDir }) => { readDirs.push(configDir); return reading('claude', 10); } });
  app.registerIpc();
  app.configureClaudeWatcher();
  await flush();
  app.handles.get('settings:patch')({}, { claudeActiveProfile: WORK });
  await flush();
  assert.equal(app.watchers.length, 2);
  assert.equal(app.watchers[0].stopped, true);
  assert.equal(readDirs.at(-1), 'C:/fake/work');
  assert.equal(app.getMerged()[WORK].windows[0].usedPercent, 10);
  assert.equal(app.getMerged().claude.lastError.code, 'PAUSED');
  assert.equal(app.refreshCount(), 0);
  assert.equal(app.pollCount(), 0);
});

test('main: a network poll cannot overwrite newer watcher data with its old Claude result', async () => {
  let finishPoll;
  let latest = reading('claude', 10);
  const app = harness({ poll: () => new Promise((resolve) => { finishPoll = resolve; }), local: () => latest });
  const pending = app.pollProvidersOnce(new AbortController().signal);
  app.configureClaudeWatcher();
  await flush();
  latest = reading('claude', 42, Date.now() + 1);
  await app.watchers[0].update();
  finishPoll({ claude: reading('claude', 10), codex: reading('codex', 5) });
  await pending;
  assert.equal(app.getMerged().claude.windows[0].usedPercent, 42);
  assert.equal(app.getMerged().codex.windows[0].usedPercent, 5);
});

test('main: disabled cached providers persist but do not affect tray usage', () => {
  const app = harness();
  app.settings.patch({ providers: { ...app.settings.get().providers, zai: false } });
  app.setMerged({ zai: { ...reading('zai', 99), stale: true } });
  app.applyFreshReadings({ codex: reading('codex', 5) });
  const [, saved, ids] = app.saves.at(-1);
  assert.equal(saved.zai.windows[0].usedPercent, 99);
  assert.ok(ids.includes('zai'));
  assert.ok(ids.includes(WORK));
  assert.equal(app.gauges.at(-1), 0.05);
  assert.match(app.tips.at(-1), /Codex: 5%/);
  assert.doesNotMatch(app.tips.at(-1), /Z.ai/);
});

test('main: history save failure still broadcasts a successful local reading', async () => {
  const app = harness();
  app.history.save = () => { throw new Error('disk unavailable'); };
  app.configureClaudeWatcher();
  await flush();
  assert.equal(app.getMerged().claude.windows[0].usedPercent, 10);
  assert.match(app.tips.at(-1), /Claude: 10%/);
  assert.ok(app.warnings.some(([kind]) => kind === 'history'));
});

test('main: old-account watcher completion is discarded after switching accounts', async () => {
  let finishOldRead;
  const app = harness({ local: ({ configDir }) => configDir === 'C:/fake/work'
    ? reading('claude', 42)
    : new Promise((resolve) => { finishOldRead = resolve; }) });
  app.registerIpc();
  app.configureClaudeWatcher();
  app.handles.get('settings:patch')({}, { claudeActiveProfile: WORK });
  await flush();
  finishOldRead(reading('claude', 99));
  await flush();
  assert.equal(app.getMerged()[WORK].windows[0].usedPercent, 42);
  assert.equal(app.getMerged().claude.ok, false);
  assert.equal(app.getMerged().claude.error.code, 'PAUSED');
});

test('main: canceled network poll does not apply or save its late readings', async () => {
  let finishPoll;
  const app = harness({ poll: () => new Promise((resolve) => { finishPoll = resolve; }) });
  const controller = new AbortController();
  const pending = app.pollProvidersOnce(controller.signal);
  controller.abort();
  finishPoll({ codex: reading('codex', 99) });
  await pending;
  assert.equal(Object.keys(app.getMerged()).length, 0);
  assert.equal(app.saves.length, 0);
});

test('main: frequent local updates refresh cards without compressing history cadence', () => {
  const app = harness();
  const first = Date.now() - 60_000;
  app.applyFreshReadings({ claude: reading('claude', 10, first) });
  app.applyFreshReadings({ claude: reading('claude', 11, first + 1000) });
  assert.equal(app.getMerged().claude.windows[0].usedPercent, 11);
  assert.equal(app.history.get('claude', 'session').length, 1);
  app.applyFreshReadings({ claude: reading('claude', 12, first + 5 * 60_000) });
  assert.equal(app.history.get('claude', 'session').length, 2);
});
