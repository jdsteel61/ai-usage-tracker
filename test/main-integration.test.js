'use strict';
/* global AbortController */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DEFAULTS, sanitize } = require('../src/main/settings');
const { HistoryStore } = require('../src/main/history');
const providers = require('../src/main/providers');

const mainPath = path.resolve(__dirname, '../src/main/main.js');
const mainRequire = createRequire(mainPath);
const WORK = 'claude-profile-work';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function reading(id, percent, fetchedAt = Date.now()) {
  return { providerId: id, ok: true, fetchedAt,
    notes: id.startsWith('claude') ? ['From Claude Code status line'] : [],
    ...(id.startsWith('claude') ? { source: 'claude-statusline' } : {}),
    windows: [{ kind: 'session', label: '5 hr', usedPercent: percent,
      resetsAt: new Date(fetchedAt + 3_600_000).toISOString() }] };
}

/** Run the actual main-process functions with an unsuccessful instance lock.
 * That skips app startup naturally. All account reads, polls, watches, and
 * cache writes are mocked; history and snapshot shaping use production code. */
function harness({ poll = async () => ({}), local = () => reading('claude', 10), confirmResponse = 0, demo = false, pick = null } = {}) {
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
  const timers = [];
  const canonical = {}; // config folder -> canonical credentials path (null: folder missing)
  let refreshCount = 0;
  let pollCount = 0;
  let state = { ...DEFAULTS, providers: { ...DEFAULTS.providers },
    claudeProfiles: [{ id: WORK, label: 'Claude Work', configDir: 'C:/fake/work' }], codexProfiles: [] };
  const history = new HistoryStore('not-written');
  history.save = () => {};
  const settings = { get: () => state, patch: (partial) => (state = sanitize({ ...state, ...partial })) };
  const tray = { setImage: () => {}, setContextMenu: () => {}, setToolTip: (text) => tips.push(text) };
  const mocks = {
    electron: { app: { requestSingleInstanceLock: () => false, quit: () => {},
      setLoginItemSettings: (options) => { loginChanges.push(options); throw new Error('Unexpected login settings change'); } },
      ipcMain: { handle: (id, handler) => handles.set(id, handler), on: () => {} },
      dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: confirmResponse }; },
        showOpenDialog: async () => (pick ? { canceled: false, filePaths: [pick] } : { canceled: true, filePaths: [] }) },
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
    './claudeCredentials': { ...mainRequire('./claudeCredentials'),
      canonicalCredentialPath: (dir) => (Object.hasOwn(canonical, dir) ? canonical[dir] : `${dir}/.credentials.json`) },
    './readingCache': { loadReadings: () => ({}), saveReadings: (...args) => saves.push(args) },
    './icon': { drawGauge: (_size, fill) => { gauges.push(fill); return Buffer.alloc(0); } },
  };
  const context = vm.createContext({
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : mainRequire(id),
    __dirname: path.dirname(mainPath), process: { env: demo ? { AITRACKER_DEMO: '1' } : {}, argv: [], cwd: () => 'C:/fake' },
    setTimeout: (fn, ms) => {
      const timer = { ms, unref: () => {}, fire: () => { timers.splice(timers.indexOf(timer), 1); fn(); } };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1); }, Buffer, injected: { settings, history, tray,
      log: { debug: () => {}, info: () => {}, warn: (...args) => warnings.push(args), error: () => {} },
      scheduler: { refreshNow: () => { refreshCount++; }, start: () => {} } },
  });
  const source = fs.readFileSync(mainPath, 'utf8');
  vm.runInContext(`${source}\nsettings = injected.settings; history = injected.history;
    tray = injected.tray; log = injected.log; scheduler = injected.scheduler;
    readingsPath = 'C:/fake/readings.json';
    globalThis.hooks = { registerIpc, configureClaudeWatcher, pollProvidersOnce, applyLoginItemSettings,
      applyFreshReadings, updateTrayFromSnapshot, readClaudeAccount, refreshClaudeAccounts, purgeProfileData,
      setBudget: (v) => { claudeBudget = v; }, getActiveAlerts: () => activeAlerts,
      getMerged: () => lastMerged, setMerged: (v) => { lastMerged = v; } };`, context);
  return { ...context.hooks, settings, handles, timers, canonical, watchers, saves, gauges, tips, warnings, history, dialogs, captureChanges,
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

test('main: every enabled Claude account is watched at once, without network polling', async () => {
  const readDirs = [];
  const app = harness({ local: ({ configDir }) => { readDirs.push(configDir); return reading('claude', 10); } });
  app.registerIpc();
  app.configureClaudeWatcher();
  await flush();
  assert.equal(app.watchers.length, 2);
  assert.ok(app.watchers.every((w) => !w.stopped));
  assert.ok(app.watchers.some((w) => w.file.includes('work')));
  assert.ok(readDirs.includes('C:/fake/work'));
  assert.equal(app.getMerged()[WORK].windows[0].usedPercent, 10);
  assert.equal(app.getMerged().claude.windows[0].usedPercent, 10);
  assert.equal(app.getMerged().claude.lastError, undefined);
  app.configureClaudeWatcher(); // idempotent
  assert.equal(app.watchers.length, 2);
  assert.equal(app.refreshCount(), 0);
  assert.equal(app.pollCount(), 0);
});

test('main: disabling Claude or removing a profile stops only the affected watchers', async () => {
  const app = harness();
  app.registerIpc();
  app.configureClaudeWatcher();
  app.handles.get('subscription-profile:remove')({}, 'claude', WORK);
  assert.deepEqual(app.watchers.map((w) => w.stopped), [false, true]);
  app.handles.get('settings:patch')({}, { providers: { ...app.settings.get().providers, claude: false } });
  assert.ok(app.watchers.every((w) => w.stopped));
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

test('main: late watcher completion is discarded after its account stops being watched', async () => {
  let finishRead;
  const app = harness({ local: () => new Promise((resolve) => { finishRead = resolve; }) });
  app.registerIpc();
  app.configureClaudeWatcher();
  app.handles.get('settings:patch')({}, { providers: { ...app.settings.get().providers, claude: false } });
  await flush();
  finishRead(reading('claude', 99));
  await flush();
  assert.equal(app.getMerged().claude, undefined);
});

test('main: API top-up is enabled only through the confirmed request, never through settings:patch', async () => {
  const declined = harness({ confirmResponse: 0 });
  declined.registerIpc();
  const refused = await declined.handles.get('claude:setApiTopUp')({}, WORK, true);
  assert.equal(refused.canceled, true);
  assert.equal(JSON.stringify(declined.settings.get().claudeApiTopUp), JSON.stringify({}));
  assert.match(declined.dialogs[0].detail, /never writes or refreshes credentials/);
  assert.match(declined.dialogs[0].detail, /C:\/fake\/work/);

  const app = harness({ confirmResponse: 1 });
  app.registerIpc();
  app.handles.get('settings:patch')({}, { claudeApiTopUp: { claude: true } });
  assert.equal(JSON.stringify(app.settings.get().claudeApiTopUp), JSON.stringify({}));
  assert.equal((await app.handles.get('claude:setApiTopUp')({}, WORK, true)).ok, true);
  assert.equal(JSON.stringify(app.settings.get().claudeApiTopUp), JSON.stringify({ [WORK]: true }));
  assert.equal((await app.handles.get('claude:setApiTopUp')({}, WORK, false)).ok, true);
  assert.equal(JSON.stringify(app.settings.get().claudeApiTopUp), JSON.stringify({}));
  assert.equal(app.dialogs.length, 1, 'turning it off needs no confirmation');
  assert.equal((await app.handles.get('claude:setApiTopUp')({}, 'claude-profile-missing', true)).ok, false);
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

// ------------------------------------------------------------ freshness at commit time

test('main: reproduction - a deferred 429 result cannot restore an older reading over newer watcher data', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const stale10 = { ...reading('claude', 10, Date.now() - 30 * 60_000), stale: true, lastError: { code: 'HTTP_429', message: 'rate limited' } };
  const app = harness({ local: async () => {
    calls++;
    if (calls === 1) { await gate; return stale10; }
    return reading('claude', 90);
  } });
  const pending = app.pollProvidersOnce(new AbortController().signal);
  await flush();
  app.configureClaudeWatcher();
  await flush();
  assert.equal(app.getMerged().claude.windows[0].usedPercent, 90, 'watcher published newer usage while the API call was pending');
  release();
  await pending;
  assert.equal(app.getMerged().claude.windows[0].usedPercent, 90, 'the late 429 result did not overwrite it');
  assert.equal(app.getMerged().claude.lastError, undefined);
  assert.equal(app.getMerged().claude.stale, false);
});

test('main: commit-time reconciliation is per window', () => {
  const app = harness();
  const w = (kind, percent, observedAt) => ({ kind, label: kind, usedPercent: percent, observedAt,
    resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
  const now = Date.now();
  const snap = (windows, fetchedAt) => ({ providerId: 'claude', ok: true, source: 'claude-statusline',
    notes: ['From Claude Code status line'], fetchedAt, stale: false, windows });
  app.applyFreshReadings({ claude: snap([w('session', 90, now - 1000), w('weekly', 20, now - 9000)], now - 9000) });
  app.applyFreshReadings({ claude: snap([w('session', 10, now - 5000), w('weekly', 40, now - 2000)], now - 5000) });
  const byKind = Object.fromEntries(app.getMerged().claude.windows.map((x) => [x.kind, x.usedPercent]));
  assert.deepEqual(byKind, { session: 90, weekly: 40 });
});

// ------------------------------------------------------------ scheduling

test('main: Claude accounts are read oldest observation first', async () => {
  const order = [];
  const app = harness({ local: ({ profileId }) => { order.push(profileId); return reading(profileId, 10); } });
  const now = Date.now();
  app.setMerged({ claude: reading('claude', 10, now), [WORK]: reading(WORK, 10, now - 3_600_000) });
  await app.refreshClaudeAccounts();
  assert.deepEqual(order, [WORK, 'claude']);
});

test('main: a round that had to wait schedules itself for when the API budget allows, and applies the result', async () => {
  let waiting = true;
  const calls = [];
  const app = harness({ local: ({ profileId }) => {
    calls.push(profileId);
    const snap = reading(profileId, 10);
    return waiting && profileId === WORK ? { ...snap, topUpRetryAt: Date.now() + 120_000 } : snap;
  } });
  await app.refreshClaudeAccounts();
  assert.equal(app.timers.length, 1);
  assert.ok(app.timers[0].ms >= 120_000 - 1000 && app.timers[0].ms <= 125_500, `delay ${app.timers[0].ms}`);
  waiting = false;
  const [timer] = app.timers;
  timer.fire();
  await flush();
  await flush();
  assert.equal(calls.length, 4, 'both accounts were read again by the timer');
  assert.equal(app.timers.length, 0, 'nothing left waiting, so no further timer');
});

// ------------------------------------------------------------ credential approval

test('main: settings:patch cannot repoint a profile folder, add profiles, or touch API approval', async () => {
  const app = harness({ confirmResponse: 1 });
  app.registerIpc();
  assert.equal((await app.handles.get('claude:setApiTopUp')({}, WORK, true)).ok, true);
  assert.match(app.dialogs[0].detail, /Credentials file: C:\/fake\/work\/\.credentials\.json/);
  assert.deepEqual(app.settings.get().claudeApiApproval, { [WORK]: 'C:/fake/work/.credentials.json' });
  const before = JSON.stringify(app.settings.get().claudeProfiles);
  await app.handles.get('settings:patch')({}, {
    claudeProfiles: [{ id: WORK, label: 'Claude Work', configDir: 'C:/fake/work/../../victim' },
      { id: 'claude-profile-new', label: 'New', configDir: 'C:/other' }],
    codexProfiles: [{ id: 'codex-profile-x', label: 'X', configDir: 'C:/other' }],
    claudeApiApproval: { claude: 'C:/x/.credentials.json' },
    claudeApiTopUp: { claude: true },
    usedProfileIds: [],
    alwaysOnTop: false,
  });
  assert.equal(JSON.stringify(app.settings.get().claudeProfiles), before);
  assert.deepEqual(app.settings.get().codexProfiles, []);
  assert.deepEqual(app.settings.get().claudeApiApproval, { [WORK]: 'C:/fake/work/.credentials.json' });
  assert.deepEqual(app.settings.get().claudeApiTopUp, { [WORK]: true });
  assert.equal(app.settings.get().alwaysOnTop, false, 'ordinary settings still apply');
  assert.deepEqual(app.watchers.filter((w) => w.file.includes('victim')), []);
});

test('main: API top-up approval is bound to the canonical credentials location', async () => {
  const seen = [];
  const app = harness({ confirmResponse: 1, local: ({ apiTopUp, profileId }) => { seen.push(apiTopUp); return reading(profileId, 10); } });
  app.registerIpc();
  await app.handles.get('claude:setApiTopUp')({}, WORK, true);
  await flush();
  seen.length = 0;
  await app.readClaudeAccount(WORK, 'C:/fake/work');
  assert.deepEqual(seen, [true]);

  app.canonical['C:/fake/work'] = null; // folder temporarily missing: nothing is read, approval is kept
  await app.readClaudeAccount(WORK, 'C:/fake/work');
  assert.equal(seen.at(-1), false);
  assert.equal(app.settings.get().claudeApiTopUp[WORK], true);

  app.canonical['C:/fake/work'] = 'D:/elsewhere/.credentials.json'; // junction now points somewhere else
  await app.readClaudeAccount(WORK, 'C:/fake/work');
  assert.equal(seen.at(-1), false);
  assert.deepEqual(app.settings.get().claudeApiTopUp, {}, 'approval cleared when the location changes');
  assert.deepEqual(app.settings.get().claudeApiApproval, {});
  delete app.canonical['C:/fake/work']; // pointing back does not resurrect it
  await app.readClaudeAccount(WORK, 'C:/fake/work');
  assert.equal(seen.at(-1), false);
  assert.ok(app.warnings.some(([kind, message]) => kind === 'claude-api' && /approval cleared/.test(message)));
});

test('main: an opt-in without a bound location (older settings) is not honoured', async () => {
  const seen = [];
  const app = harness({ local: ({ apiTopUp, profileId }) => { seen.push(apiTopUp); return reading(profileId, 10); } });
  app.settings.patch({ claudeApiTopUp: { [WORK]: true } });
  await app.readClaudeAccount(WORK, 'C:/fake/work');
  assert.deepEqual(seen, [false]);
  assert.deepEqual(app.settings.get().claudeApiTopUp, {});
});

test('main: enabling API top-up for a folder that cannot be resolved is refused before any dialog', async () => {
  const app = harness({ confirmResponse: 1 });
  app.registerIpc();
  app.canonical['C:/fake/work'] = null;
  const result = await app.handles.get('claude:setApiTopUp')({}, WORK, true);
  assert.equal(result.ok, false);
  assert.equal(app.dialogs.length, 0);
});

// ------------------------------------------------------------ profile identity

test('main: profile ids are never reused and removal purges every trace of the old account', async () => {
  const purged = [];
  const app = harness({ pick: path.resolve('C:/fake/Acme') });
  app.setBudget({ purge: (id) => purged.push(id), lastAttempt: () => -Infinity });
  app.registerIpc();
  const added = await app.handles.get('subscription-profile:add')({}, 'claude');
  assert.equal(added.ok, true);
  const first = added.settings.claudeProfiles.find((p) => p.id.includes('acme')).id;
  assert.ok(first);

  // data stored under that account
  app.setMerged({ ...app.getMerged(), [first]: reading(first, 88) });
  app.history.append(first, 'session', { t: Date.now(), percent: 88, resetsAt: null, state: 'ok' });
  app.settings.patch({ claudeApiTopUp: { [first]: true }, claudeApiApproval: { [first]: 'x' } });
  app.saves.length = 0;

  await app.handles.get('subscription-profile:remove')({}, 'claude', first);
  assert.equal(app.getMerged()[first], undefined);
  assert.deepEqual(app.history.get(first, 'session'), []);
  assert.ok(purged.includes(first), 'API budget entry dropped');
  assert.ok(!Object.hasOwn(app.saves.at(-1)[1], first), 'stored readings no longer include it');
  assert.deepEqual(app.settings.get().claudeApiTopUp, {});
  assert.deepEqual(app.settings.get().claudeApiApproval, {});
  assert.ok(app.settings.get().usedProfileIds.includes(first), 'the id stays retired');

  // adding the same folder name again (a different account) must not reuse the id
  const id = (await app.handles.get('subscription-profile:add')({}, 'claude')).settings.claudeProfiles
    .find((p) => p.id.includes('acme')).id;
  assert.notEqual(id, first);
  assert.equal(app.getMerged()[id], undefined);
});

test('main: adding a profile starts it from a clean slate even if stale data exists under its id', async () => {
  const purged = [];
  const app = harness({ pick: path.resolve('C:/fake/Acme') });
  app.setBudget({ purge: (id) => purged.push(id), lastAttempt: () => -Infinity });
  app.registerIpc();
  const stale = 'claude-profile-acme';
  app.setMerged({ [stale]: reading(stale, 77) });
  app.history.append(stale, 'session', { t: Date.now(), percent: 77, resetsAt: null, state: 'ok' });
  const result = await app.handles.get('subscription-profile:add')({}, 'claude');
  assert.ok(result.settings.claudeProfiles.some((p) => p.id === stale));
  assert.equal(app.getMerged()[stale], undefined);
  assert.deepEqual(app.history.get(stale, 'session'), []);
  assert.ok(purged.includes(stale));
});

test('settings: existing profile ids migrate into the retired list and survive removal', () => {
  const migrated = sanitize({ claudeProfiles: [{ id: 'claude-profile-work', label: 'W', configDir: 'C:/w' }],
    codexProfiles: [{ id: 'codex-profile-a', label: 'A', configDir: 'C:/a' }] });
  assert.deepEqual([...migrated.usedProfileIds].sort(), ['claude-profile-work', 'codex-profile-a']);
  const removed = sanitize({ ...migrated, claudeProfiles: [] });
  assert.ok(removed.usedProfileIds.includes('claude-profile-work'));
  assert.deepEqual(sanitize({ usedProfileIds: ['evil', 42, 'claude-profile-ok'] }).usedProfileIds, ['claude-profile-ok']);
  assert.deepEqual(DEFAULTS.usedProfileIds, [], 'shared defaults are never mutated');
  assert.equal(DEFAULTS.providers.claude, true);
});
