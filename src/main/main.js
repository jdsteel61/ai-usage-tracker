'use strict';

/**
 * AI Usage Tracker - Electron main process.
 *
 * Compact always-on-top usage panel for Codex, Claude Code, and Z.ai quota
 * windows, living in the notification area. See README.md for architecture.
 */
const path = require('path');
const { installCapture, restoreCapture, usagePath } = require('./claudeStatusline');
const { watchClaudeUsage } = require('./claudeWatcher');
const { ClaudeApiBudget } = require('./claudeApiBudget');
const { fetchClaudeQuotas } = require('./providers/claude');
const { reconcileClaudeReadings, orderByObservationAge } = require('./claudeMerge');
const { canonicalCredentialPath, samePath } = require('./claudeCredentials');
const { loadReadings, saveReadings } = require('./readingCache');
const os = require('os');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, nativeTheme, screen, clipboard, powerMonitor,
} = require('electron');

const { SettingsStore } = require('./settings');
const { HistoryStore, ingestSnapshot } = require('./history');
const { Logger } = require('./logger');
const { Scheduler } = require('./scheduler');
const { clampToBounds } = require('./windowState');
const { drawGauge } = require('./icon');
const credentials = require('./credentials');
const { pollAll, mergeWithCache, createRegistry } = require('./providers');
const { detectSpike, applyAlert, describeAlert } = require('./spikes');
const { shapeSnapshot } = require('./snapshotView');
const { loadDemoSnapshots } = require('./demo');

const IS_DEMO = !!process.env.AITRACKER_DEMO;
const screenshotDir = (() => {
  const i = process.argv.indexOf('--screenshot');
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')) return process.argv[i + 1];
  return i !== -1 ? path.join(process.cwd(), 'screenshots') : null;
})();

// Dev/testing override: isolate userData (and thus the single-instance lock)
// so self-tests can run next to a live instance. Must run BEFORE the lock is
// requested, because the lock is keyed by the userData path.
if (process.env.AITRACKER_USERDATA) {
  try { app.setPath('userData', process.env.AITRACKER_USERDATA); } catch { /* fall through */ }
}

// Single-instance guard: a second launch reveals the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

let mainWindow = null;
let tray = null;
let settings = null;
let history = null;
let log = null;
let scheduler = null;
let activeAlerts = {};
let lastSnapshot = null; // newest reading, replayed into a rebuilt window
let lastMerged = {};      // raw merged provider map from the last poll
let readingsPath = null;
const claudeWatchers = new Map(); // usage.json path -> { id, active, stop }
let claudeBudget = null;

function configuredIds(s = settings.get()) {
  return [...Object.keys(s.providers), ...s.codexProfiles.map((p) => p.id),
    ...s.claudeProfiles.map((p) => p.id)];
}

/** The default account plus every added profile, each with its own config folder. */
function claudeAccounts(s = settings.get()) {
  return [{ id: 'claude', configDir: path.join(os.homedir(), '.claude') },
    ...s.claudeProfiles.map((p) => ({ id: p.id, configDir: p.configDir }))];
}

/** True only while the user's approval still matches this account's canonical
 * credentials location. If the folder now resolves elsewhere (or the opt-in
 * predates path binding) the approval is cleared and must be given again. */
function claudeApiAllowed(id, configDir) {
  const s = settings.get();
  if (s.claudeApiTopUp[id] !== true) return false;
  const current = canonicalCredentialPath(configDir);
  if (!current) return false; // folder unavailable: nothing is read
  if (samePath(current, s.claudeApiApproval[id])) return true;
  const topUp = { ...s.claudeApiTopUp };
  const approval = { ...s.claudeApiApproval };
  delete topUp[id];
  delete approval[id];
  settings.patch({ claudeApiTopUp: topUp, claudeApiApproval: approval });
  log.warn('claude-api', `${id}: API top-up approval cleared because its credentials location changed`);
  return false;
}

/** Local capture plus the opt-in API top-up for one account. Never throws. */
async function readClaudeAccount(id, configDir, signal) {
  const snap = await fetchClaudeQuotas({
    configDir, profileId: id, signal, budget: claudeBudget, previous: lastMerged[id],
    apiTopUp: claudeApiAllowed(id, configDir),
  });
  return { ...snap, providerId: id };
}

// Claude accounts are read one round at a time, oldest observation first, so
// with many accounts none starves. A round that had to wait for the API budget
// schedules itself again for when the budget next allows a call.
let claudeChain = Promise.resolve();
let claudeRetryTimer = null;

function nextTopUpTime(snap) {
  if (Number.isFinite(snap.topUpRetryAt)) return snap.topUpRetryAt;
  return !snap.ok && snap.error && Number.isFinite(snap.error.retryAt) ? snap.error.retryAt : null;
}

function scheduleClaudeRetry(retryAt) {
  if (claudeRetryTimer) { clearTimeout(claudeRetryTimer); claudeRetryTimer = null; }
  if (!Number.isFinite(retryAt)) return;
  const delay = Math.min(Math.max(1000, retryAt - Date.now()) + Math.floor(Math.random() * 5000), 2 ** 31 - 1);
  claudeRetryTimer = setTimeout(() => {
    claudeRetryTimer = null;
    refreshClaudeAccounts().then((fresh) => { if (fresh) applyFreshReadings(fresh); })
      .catch((cause) => log.warn('claude-api', cause.message));
  }, delay);
  if (claudeRetryTimer.unref) claudeRetryTimer.unref();
}

/** Returns { <id>: snapshot } for every enabled account, or null when canceled. */
function refreshClaudeAccounts(signal) {
  const run = claudeChain.then(async () => {
    const s = settings.get();
    if (!s.providers.claude) { scheduleClaudeRetry(null); return {}; }
    const fresh = {};
    let retryAt = null;
    const accounts = claudeAccounts(s);
    const byId = new Map(accounts.map((account) => [account.id, account]));
    for (const id of orderByObservationAge(accounts.map((a) => a.id), lastMerged, (x) => (claudeBudget ? claudeBudget.lastAttempt(x) : -Infinity))) {
      const snap = await readClaudeAccount(id, byId.get(id).configDir, signal);
      if (signal && signal.aborted) return null;
      fresh[id] = snap;
      const at = nextTopUpTime(snap);
      if (at !== null && (retryAt === null || at < retryAt)) retryAt = at;
    }
    scheduleClaudeRetry(retryAt);
    return fresh;
  });
  claudeChain = run.catch(() => {});
  return run;
}

/** Watch every enabled account's local capture file, not only one. */
function configureClaudeWatcher() {
  const s = settings.get();
  const wanted = new Map();
  if (!IS_DEMO && s.providers.claude) {
    for (const account of claudeAccounts(s)) wanted.set(usagePath(account.configDir), account);
  }
  for (const [filePath, watcher] of claudeWatchers) {
    if (wanted.get(filePath)?.id === watcher.id) continue;
    watcher.active = false;
    watcher.stop();
    claudeWatchers.delete(filePath);
  }
  for (const [filePath, { id, configDir }] of wanted) {
    if (claudeWatchers.has(filePath)) continue;
    const watcher = { id, active: true, stop: null };
    const update = async () => {
      const snap = await readClaudeAccount(id, configDir);
      if (watcher.active) applyFreshReadings({ [id]: snap });
    };
    const safeUpdate = () => update().catch((cause) => log.warn('claude-watch', cause.message));
    claudeWatchers.set(filePath, watcher);
    watcher.stop = watchClaudeUsage(filePath, safeUpdate);
    safeUpdate();
  }
}

function main() {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    settings = new SettingsStore(path.join(userData, 'settings.json'));
    settings.load();
    readingsPath = path.join(userData, 'readings.json');
    lastMerged = {
      ...loadReadings(path.join(userData, 'claude-readings.json'),
        ['claude', ...settings.get().claudeProfiles.map((profile) => profile.id)]),
      ...loadReadings(readingsPath, configuredIds()),
    };
    history = new HistoryStore(path.join(userData, 'history.json'));
    history.load();
    history.prune();
    log = new Logger(path.join(userData, 'logs', 'main.log'));
    log.open();
    log.info('app', `started (v${app.getVersion()}${IS_DEMO ? ' demo' : ''})`);

    nativeTheme.themeSource = settings.get().theme;
    applyLoginItemSettings();
    createTray();
    createWindow();
    registerIpc();

    claudeBudget = new ClaudeApiBudget(path.join(userData, 'claude-api-budget.json'));
    claudeBudget.retainOnly(claudeAccounts().map((account) => account.id));
    scheduler = new Scheduler(pollProvidersOnce);
    configureClaudeWatcher();
    broadcast(lastMerged, Date.now());
    scheduler.start(settings.get().intervalMinutes);

    // Data goes stale while the machine sleeps or is locked: refresh as soon
    // as the system comes back.
    powerMonitor.on('resume', () => {
      log.info('power', 'system resumed - refreshing');
      scheduler.refreshNow();
    });
    powerMonitor.on('unlock-screen', () => {
      log.debug('power', 'screen unlocked - refreshing');
      scheduler.refreshNow();
    });

    app.on('activate', () => showMainWindow()); // macOS parity, harmless on Windows
  });

  app.on('window-all-closed', (e) => { /* keep running in tray */ });

  app.on('before-quit', () => {
    if (scheduler) scheduler.stop(); // graceful cancellation of in-flight polls
    for (const watcher of claudeWatchers.values()) { watcher.active = false; watcher.stop(); }
    claudeWatchers.clear();
  });
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const bounds = clampToBounds(settings.get().windowBounds, workArea);
  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    minWidth: 250, minHeight: 170,
    useContentSize: true,
    frame: false,            // no title bar, no File/Edit/View menu bar
    autoHideMenuBar: true,
    title: 'AI Usage',
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: settings.get().alwaysOnTop,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); });
  mainWindow.on('close', (e) => {
    // Close hides to tray; Quit comes from the tray menu.
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const [x, y] = mainWindow.getPosition();
    const [width, height] = mainWindow.getContentSize();
    settings.patch({ windowBounds: { x, y, width, height } });
  };
  let persistTimer = null;
  const throttledPersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persistBounds(); }, 800);
  };
  mainWindow.on('resize', throttledPersist);
  mainWindow.on('move', throttledPersist);

  mainWindow.webContents.on('did-finish-load', () => {
    if (lastSnapshot && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('snapshot', lastSnapshot);
    } else if (scheduler) {
      // Fresh boot with no snapshot yet (first poll raced page load): poll
      // again now so the window populates immediately instead of waiting a
      // full interval.
      scheduler.refreshNow();
    }
    if (screenshotDir) scheduleScreenshots();
    if (process.env.AITRACKER_SELFTEST) runSettingsSelftest();
  });
  mainWindow.webContents.on('console-message', (_e, _level, message, _line, sourceId) => {
    if (process.env.AITRACKER_SELFTEST || process.env.AITRACKER_DEBUG) {
      log.info('renderer-console', `${String(message).slice(0, 300)} (${sourceId})`);
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconBuf = drawGauge(16, 0);
  tray = new Tray(nativeImage.createFromBuffer(iconBuf, { scaleFactor: 1 }));
  tray.setToolTip('AI Usage Tracker');
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showMainWindow();
  });
  rebuildTrayMenu();
}

function rebuildTrayMenu(fill = 0) {
  if (!tray) return;
  const s = settings.get();
  tray.setImage(nativeImage.createFromBuffer(drawGauge(16, fill), { scaleFactor: 1 }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => { if (mainWindow && mainWindow.isVisible()) mainWindow.hide(); else showMainWindow(); } },
    { label: 'Refresh now', click: () => { scheduler && scheduler.refreshNow(); } },
    { type: 'separator' },
    { label: 'Always on top', type: 'checkbox', checked: s.alwaysOnTop, click: (item) => ipcMain.emit('set-always-on-top', {}, item.checked) },
    { label: 'Launch at login', type: 'checkbox', checked: s.launchAtLogin, click: (item) => setLaunchAtLogin(item.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; tray.destroy(); app.quit(); } },
  ]));
}

// ---------------------------------------------------------------- polling

async function pollProvidersOnce(signal) {
  log.debug('poll', 'poll starting');
  if (IS_DEMO) {
    const fixturePath = process.env.AITRACKER_DEMO_FIXTURE
      || path.join(__dirname, '..', '..', 'test', 'fixtures', 'demo-snapshot.json');
    const fixtures = loadDemoSnapshots(fixturePath);
    // Demo mode shows every provider present in the fixture regardless of
    // settings, so screenshots can demonstrate any provider mix.
    const demoSettings = {
      ...settings.get(),
      providers: { ...settings.get().providers },
    };
    for (const id of Object.keys(fixtures)) demoSettings.providers[id] = true;
    settings.patch({ providers: demoSettings.providers });
    const merged = mergeWithCache(fixtures, lastMerged);
    lastMerged = merged;
    broadcast(merged, Date.now());
    return;
  }

  const s = settings.get();
  const enabled = Object.entries(s.providers).filter(([id, on]) => on && id !== 'claude').map(([id]) => id);
  if (s.providers.codex) enabled.push(...s.codexProfiles.map((profile) => profile.id));
  const claudeIds = ['claude', ...s.claudeProfiles.map((profile) => profile.id)];
  const getKeyFor = (target) => async () => {
    try { return await credentials.readSecret({ target }); } catch { return null; }
  };
  const registry = createRegistry({
    codexProfiles: s.codexProfiles,
    claudeProfiles: s.claudeProfiles,
    zaiDeps: {
      getKey: getKeyFor(credentials.TARGET),
      baseUrl: s.zaiBaseUrl,
    },
    grokDeps: { getKey: getKeyFor('ai-usage-tracker:grok-api-key') },
    geminiDeps: { getKey: getKeyFor('ai-usage-tracker:gemini-api-key') },
    openrouterDeps: { getKey: getKeyFor('ai-usage-tracker:openrouter-api-key') },
  }).filter((p) => enabled.includes(p.id));

  const fresh = await pollAll(registry, { signal });
  if (signal && signal.aborted) return;
  // Claude is read after the network polls and merges with the stored reading,
  // so a poll can never replace newer watcher data with an older result.
  for (const id of claudeIds) delete fresh[id];
  const claude = await refreshClaudeAccounts(signal);
  if (!claude || (signal && signal.aborted)) return;
  Object.assign(fresh, claude);
  applyFreshReadings(fresh);
}

function applyFreshReadings(freshInput) {
  const s = settings.get();
  // Results can finish long after they were started (API calls, polls, watchers).
  // At commit time a Claude window is replaced only by a newer observation.
  const fresh = { ...freshInput };
  for (const [id, snap] of Object.entries(fresh)) {
    if (id === 'claude' || id.startsWith('claude-profile-')) fresh[id] = reconcileClaudeReadings(lastMerged[id], snap);
  }
  for (const [id, snap] of Object.entries(fresh)) {
    if (!snap.ok) {
      if (snap.error && !['NO_DATA', 'QUEUED', 'SUSPENDED'].includes(snap.error.code) && !snap.cooldown) {
        log.warn('poll', `${id}: ${snap.error.code} - ${snap.error.message}`);
      }
    } else {
      const ws = Array.isArray(snap.windows) ? snap.windows : [];
      const meaningful = ws.filter((w) => w.kind === 'session' || w.kind === 'weekly').length;
      if (meaningful === 0) {
        const notes = Array.isArray(snap.notes) && snap.notes.length ? ` | ${snap.notes.join('; ')}` : '';
        log.warn('poll', `${id}: reachable, but no session/weekly quota windows (plan=${snap.plan || 'none'}, windows=${ws.length})${notes}`);
      }
    }
  }
  const previousMerged = lastMerged;
  const merged = { ...lastMerged, ...mergeWithCache(fresh, lastMerged) };
  lastMerged = merged;
  if (Object.values(fresh).some((snap) => snap && snap.ok)) {
    try { saveReadings(readingsPath, merged, configuredIds()); }
    catch (cause) { log.warn('poll', `Could not save last readings: ${cause.message}`); }
  }

  // Only fresh readings enter history or spike detection.
  const now = Date.now();
  for (const snap of Object.values(fresh)) {
    if (!snap.ok || snap.stale || (previousMerged[snap.providerId]?.fetchedAt === snap.fetchedAt
      && JSON.stringify(previousMerged[snap.providerId]?.windows) === JSON.stringify(snap.windows))) continue;
    if (snap.source === 'claude-statusline') {
      const lastSampleAt = Math.max(0, ...['session', 'weekly'].map((kind) =>
        history.get(snap.providerId, kind).at(-1)?.t || 0));
      if (snap.fetchedAt - lastSampleAt < s.intervalMinutes * 60_000) continue;
    }
    ingestSnapshot(history, snap, snap.fetchedAt || now);
    for (const w of snap.windows) {
      if (w.kind !== 'session' && w.kind !== 'weekly') continue;
      if (!Number.isFinite(w.usedPercent)) continue;
      const samples = history.get(snap.providerId, w.kind);
      const alert = detectSpike(snap.providerId, w.kind, samples, {
        intervalMinutes: s.intervalMinutes,
        absolutePoints: s.spikeAbsolutePoints,
        relativePoints: s.spikeRelativePoints,
        relativeMultiplier: s.spikeRelativeMultiplier,
      }, now);
      if (alert) {
        activeAlerts = applyAlert(activeAlerts, alert, s.spikeAlertMinutes, now);
        log.warn('spike', describeAlert(alert));
      }
    }
  }
  history.prune(now);
  try { history.save(); }
  catch (cause) { log.warn('history', `Could not save history: ${cause.message}`); }

  broadcast(merged, now);
}

/** Forget everything stored for a profile id: readings, history, alerts, API budget. */
function purgeProfileData(id) {
  lastMerged = Object.fromEntries(Object.entries(lastMerged).filter(([key]) => key !== id));
  activeAlerts = Object.fromEntries(Object.entries(activeAlerts).filter(([key]) => !key.startsWith(`${id}:`)));
  history.purge(id);
  if (claudeBudget) claudeBudget.purge(id);
  try { saveReadings(readingsPath, lastMerged, configuredIds()); }
  catch (cause) { log.warn('profile', `Could not save readings: ${cause.message}`); }
  try { history.save(); }
  catch (cause) { log.warn('history', `Could not save history: ${cause.message}`); }
}

function broadcast(merged, now) {
  const s = settings.get();
  let view;
  try {
    view = shapeSnapshot(merged, { settings: s, activeAlerts, now });
  } catch (cause) {
    // Shaping must never take the app down; log and fall back to an empty view.
    log.error('broadcast', `snapshot shaping failed: ${cause.message}`);
    view = shapeSnapshot({}, { settings: s, activeAlerts: {}, now });
  }
  lastSnapshot = view;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot', lastSnapshot);
    log.debug('broadcast', `snapshot sent (${view.providers.map((p) => `${p.id}:${p.ok ? 'ok' : 'err'}`).join(', ')})`);
  }
  updateTrayFromSnapshot(lastSnapshot);
}

function updateTrayFromSnapshot(snapshot) {
  let max = 0;
  for (const p of snapshot.providers) {
    if (!p.ok || p.enabled === false) continue;
    for (const kind of ['session', 'weekly']) {
      const w = p.windows[kind];
      if (w && Number.isFinite(w.usedPercent)) max = Math.max(max, w.usedPercent);
    }
  }
  const fill = max / 100;
  rebuildTrayMenu(fill);
  if (tray) {
    const parts = snapshot.providers.filter((p) => p.ok && p.enabled !== false).map((p) => {
      const s = p.windows.session ? `${Math.round(p.windows.session.usedPercent)}%` : '—';
      const w = p.windows.weekly ? `${Math.round(p.windows.weekly.usedPercent)}%` : '—';
      return `${p.title}: ${s} / ${w}`;
    });
    tray.setToolTip(parts.length ? `AI Usage\n${parts.join('\n')}` : 'AI Usage Tracker');
  }
}

// ---------------------------------------------------------------- login item

function applyLoginItemSettings() {
  if (IS_DEMO) return;
  const enabled = !!settings.get().launchAtLogin;
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, name: 'AI Usage Tracker' });
  } catch (cause) {
    log.warn('startup', `could not apply login item: ${cause.message}`);
  }
}

function setLaunchAtLogin(enabled) {
  settings.patch({ launchAtLogin: !!enabled });
  applyLoginItemSettings();
  rebuildTrayMenu();
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings.get() }));
  ipcMain.handle('settings:patch', (_e, partials) => {
    // Never reject: a settings failure must not wedge the UI (e.g. the
    // settings panel's Done button). Log, fall back to current values.
    let next;
    try {
      const before = settings.get();
      // API top-up is changed only through its confirmed claude:setApiTopUp request.
      // Profile folders, API top-up approval and issued ids change only through
      // their own confirmed requests, never through this generic channel.
      const allowed = { ...partials };
      for (const key of ['claudeApiTopUp', 'claudeApiApproval', 'usedProfileIds', 'claudeProfiles', 'codexProfiles']) delete allowed[key];
      next = settings.patch(allowed);
      if (next.theme !== before.theme) nativeTheme.themeSource = next.theme;
      if (next.alwaysOnTop !== before.alwaysOnTop && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(next.alwaysOnTop);
      }
      if (next.intervalMinutes !== before.intervalMinutes && scheduler) {
        scheduler.start(next.intervalMinutes);
      }
      configureClaudeWatcher();
      if (next.launchAtLogin !== before.launchAtLogin) {
        applyLoginItemSettings();
      }
    } catch (cause) {
      log.error('settings', `patch failed: ${cause.message}`);
      next = settings.get();
    }
    rebuildTrayMenu();
    broadcast(lastMerged, Date.now());
    return { ...next };
  });

  async function addSubscriptionProfile(provider) {
    const kind = provider === 'codex' ? 'Codex' : 'Claude Code';
    const settingKey = provider === 'codex' ? 'codexProfiles' : 'claudeProfiles';
    const defaultDir = provider === 'codex'
      ? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
      : path.join(os.homedir(), '.claude');
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: `Choose a ${kind} profile folder`,
      defaultPath: os.homedir(),
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    const configDir = path.resolve(picked.filePaths[0]);
    const profiles = settings.get()[settingKey];
    if ([defaultDir, ...profiles.map((p) => p.configDir)].some((dir) => path.resolve(dir).toLowerCase() === configDir.toLowerCase())) {
      return { ok: false, error: `That ${kind} profile is already being tracked.` };
    }
    if (profiles.length >= 20) return { ok: false, error: `The tracker supports up to 20 additional ${kind} profiles.` };
    const folder = path.basename(configDir).replace(/^\./, '').replace(/^(claude|codex)[-_]*/i, '');
    const readable = folder.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Profile';
    const label = `${provider === 'codex' ? 'Codex' : 'Claude'} ${readable}`.slice(0, 40);
    const prefix = provider === 'codex' ? 'codex-profile-' : 'claude-profile-';
    const base = `${prefix}${folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'extra'}`;
    // Ids are never reused, even after a profile is removed, so a new profile
    // cannot inherit another account's saved readings, history or budget.
    const used = new Set([...profiles.map((p) => p.id), ...settings.get().usedProfileIds]);
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    purgeProfileData(id); // leftovers from before ids were tracked
    const next = settings.patch({ [settingKey]: [...profiles, { id, label, configDir }] });
    configureClaudeWatcher();
    if (provider === 'codex' && scheduler) scheduler.refreshNow();
    broadcast(lastMerged, Date.now());
    return { ok: true, settings: { ...next } };
  }
  ipcMain.handle('subscription-profile:add', (_e, provider) => {
    if (provider !== 'codex' && provider !== 'claude') return { ok: false, error: 'Unknown provider' };
    return addSubscriptionProfile(provider);
  });
  ipcMain.handle('subscription-profile:remove', (_e, provider, profileId) => {
    const settingKey = provider === 'codex' ? 'codexProfiles' : provider === 'claude' ? 'claudeProfiles' : null;
    if (!settingKey) return { ...settings.get() };
    const next = settings.patch({ [settingKey]: settings.get()[settingKey].filter((p) => p.id !== profileId) });
    if (!next[settingKey].some((p) => p.id === profileId)) {
      const topUp = { ...next.claudeApiTopUp };
      const approval = { ...next.claudeApiApproval };
      delete topUp[profileId];
      delete approval[profileId];
      settings.patch({ claudeApiTopUp: topUp, claudeApiApproval: approval });
      purgeProfileData(profileId);
    }
    configureClaudeWatcher();
    if (provider === 'codex' && scheduler) scheduler.refreshNow();
    broadcast(lastMerged, Date.now());
    return { ...next };
  });

  ipcMain.handle('claude:enableCapture', async (_e, id) => {
    if (IS_DEMO) return { ok: false, error: 'Claude capture is disabled in demo mode' };
    const profile = settings.get().claudeProfiles.find((p) => p.id === id);
    const configDir = id === 'claude' ? path.join(os.homedir(), '.claude') : profile && profile.configDir;
    if (!configDir) return { ok: false, error: 'Unknown Claude profile' };
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Cancel', 'Enable capture'], defaultId: 0, cancelId: 0,
      message: 'Enable local Claude capture?',
      detail: `Claude config folder: ${configDir}\n\nThis wraps the statusLine command in settings.json and backs up the previous field in ai-usage-tracker/original-statusline.json. Its existing display receives the same input and keeps working. The tracker saves only usage percentages, reset times, and observation times locally. Capture itself reads no Claude credentials, sends no prompts, and makes no network requests (the separate, off-by-default API top-up setting is what may read a saved login). Node.js must be on PATH. Undo capture in Settings restores the previous field.`,
    });
    if (confirmation.response !== 1) return { ok: false, canceled: true };
    try {
      const result = installCapture(configDir);
      configureClaudeWatcher();
      return result;
    } catch (cause) {
      return { ok: false, error: cause.message };
    }
  });

  ipcMain.handle('claude:setApiTopUp', async (_e, id, enabled) => {
    if (IS_DEMO) return { ok: false, error: 'Claude API top-up is disabled in demo mode' };
    const account = claudeAccounts().find((a) => a.id === id);
    if (!account) return { ok: false, error: 'Unknown Claude profile' };
    const credentialPath = enabled ? canonicalCredentialPath(account.configDir) : null;
    if (enabled && !credentialPath) return { ok: false, error: 'That Claude config folder could not be found' };
    if (enabled) {
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'question', buttons: ['Cancel', 'Enable API top-up'], defaultId: 0, cancelId: 0,
        message: 'Allow Claude usage API top-up?',
        detail: `Claude config folder: ${account.configDir}
Credentials file: ${credentialPath}

Only when this account's local reading is missing or older than 25 minutes, the tracker reads the access token from .credentials.json in that folder and sends it to https://api.anthropic.com/api/oauth/usage to fetch usage percentages. It never writes or refreshes credentials, sends prompts, or uses model quota. That endpoint rate-limits aggressively, so calls are budgeted: at least 10 minutes per account, staggered across accounts, and backed off for hours after HTTP 429 or a sign-in rejection. This approval applies only to the credentials file shown above: if that folder later resolves elsewhere, it is cleared. Turn this off at any time in Settings.`,
      });
      if (confirmation.response !== 1) return { ok: false, canceled: true };
    }
    const current = { ...settings.get().claudeApiTopUp };
    const approval = { ...settings.get().claudeApiApproval };
    if (enabled) { current[id] = true; approval[id] = credentialPath; } else { delete current[id]; delete approval[id]; }
    const next = settings.patch({ claudeApiTopUp: current, claudeApiApproval: approval });
    if (enabled && settings.get().providers.claude) {
      readClaudeAccount(id, account.configDir).then((snap) => applyFreshReadings({ [id]: snap }))
        .catch((cause) => log.warn('claude-api', cause.message));
    }
    return { ok: true, settings: { ...next } };
  });

  ipcMain.handle('claude:restoreCapture', async (_e, id) => {
    if (IS_DEMO) return { ok: false, error: 'Claude capture is disabled in demo mode' };
    const profile = settings.get().claudeProfiles.find((p) => p.id === id);
    const configDir = id === 'claude' ? path.join(os.homedir(), '.claude') : profile && profile.configDir;
    if (!configDir) return { ok: false, error: 'Unknown Claude profile' };
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Cancel', 'Undo capture'], defaultId: 0, cancelId: 0,
      message: 'Undo local Claude capture?',
      detail: `Claude config folder: ${configDir}\n\nThis restores only the previous statusLine field in settings.json from ai-usage-tracker/original-statusline.json, or removes the field if it was originally absent. If the status line has changed, nothing is overwritten. Other Claude settings, cached usage, and helper files are kept. Removing a profile or quitting the tracker does not undo capture.`,
    });
    if (confirmation.response !== 1) return { ok: false, canceled: true };
    try {
      return restoreCapture(configDir);
    } catch (cause) {
      return { ok: false, error: cause.message };
    }
  });

  // Every action below touches a REAL stored credential. Each one requires an
  // explicit confirmation dialog before proceeding - never silent, never
  // auto-triggered, and the key itself never appears in any log or argv.
  // Generic channels serve all key-based providers; the legacy zai:*
  // channels are kept so older front-ends keep working.
  const KEY_TARGETS = {
    zai: credentials.TARGET,
    grok: 'ai-usage-tracker:grok-api-key',
    gemini: 'ai-usage-tracker:gemini-api-key',
    openrouter: 'ai-usage-tracker:openrouter-api-key',
  };
  const KEY_LABELS = { zai: 'Z.ai', grok: 'Grok (xAI)', gemini: 'Gemini', openrouter: 'OpenRouter' };
  const TEST_FETCHERS = {
    zai: (key) => require('./providers/zai').fetchZaiQuotas({ getKey: async () => key, baseUrl: settings.get().zaiBaseUrl }),
    grok: (key) => require('./providers/grok').fetchGrokQuotas({ getKey: async () => key }),
    gemini: (key) => require('./providers/gemini').fetchGeminiQuotas({ getKey: async () => key }),
    openrouter: (key) => require('./providers/openrouter').fetchOpenRouterQuotas({ getKey: async () => key }),
  };
  const keyTarget = (id) => KEY_TARGETS[id] || null;

  const confirm = async (verb, label) => (await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Confirm',
    message: `${verb} the ${label} API key in Windows Credential Manager?`,
    detail: 'The key is stored only in Windows Credential Manager. It is never written to settings files or logs.',
    buttons: ['Cancel', verb],
    defaultId: 1,
    cancelId: 0,
  })).response === 1;

  async function providerKeyExists(id) {
    if (IS_DEMO) return false;
    if (!keyTarget(id)) return null;
    try { return await credentials.secretExists({ target: keyTarget(id) }); } catch (cause) {
      log.error('credmgr', `exists check failed: ${cause.message}`);
      return null;
    }
  }
  async function providerSaveKey(id, key) {
    if (IS_DEMO) return { ok: false, error: 'API key actions are disabled in demo mode' };
    const label = KEY_LABELS[id];
    if (!label || !keyTarget(id)) return { ok: false, error: 'Unknown provider' };
    if (typeof key !== 'string' || key.trim().length < 8) return { ok: false, error: 'Key looks too short' };
    if (!(await confirm('Store', label))) return { ok: false, error: 'Cancelled' };
    try {
      await credentials.writeSecret(key.trim(), { target: keyTarget(id) });
      log.info('credmgr', `${id} key stored`);
      scheduler && scheduler.refreshNow();
      return { ok: true };
    } catch (cause) {
      log.error('credmgr', `store failed: ${cause.message}`);
      return { ok: false, error: 'Windows Credential Manager write failed' };
    }
  }
  async function providerTestKey(id) {
    if (IS_DEMO) return { ok: false, error: 'API key actions are disabled in demo mode' };
    const label = KEY_LABELS[id];
    if (!label || !keyTarget(id)) return { ok: false, error: 'Unknown provider' };
    if (!(await confirm('Test', label))) return { ok: false, error: 'Cancelled' };
    let key = null;
    try { key = await credentials.readSecret({ target: keyTarget(id) }); } catch (cause) {
      log.error('credmgr', `read failed: ${cause.message}`);
      return { ok: false, error: 'Could not read stored key' };
    }
    if (!key) return { ok: false, error: 'No key stored' };
    const snap = await TEST_FETCHERS[id](key);
    log.info('credmgr', `${id} key test: ${snap.ok ? 'ok' : snap.error.code}`);
    return snap.ok
      ? { ok: true, plan: snap.plan, windows: snap.windows.length, notes: snap.notes }
      : { ok: false, error: `${snap.error.code}: ${snap.error.message}` };
  }
  async function providerRemoveKey(id) {
    if (IS_DEMO) return { ok: false, error: 'API key actions are disabled in demo mode' };
    const label = KEY_LABELS[id];
    if (!label || !keyTarget(id)) return { ok: false, error: 'Unknown provider' };
    if (!(await confirm('Remove', label))) return { ok: false, error: 'Cancelled' };
    try {
      await credentials.deleteSecret({ target: keyTarget(id) });
      log.info('credmgr', `${id} key removed`);
      return { ok: true };
    } catch (cause) {
      log.error('credmgr', `remove failed: ${cause.message}`);
      return { ok: false, error: 'Windows Credential Manager delete failed' };
    }
  }

  ipcMain.handle('provider:keyExists', (_e, id) => providerKeyExists(id));
  ipcMain.handle('provider:saveKey', (_e, id, key) => providerSaveKey(id, key));
  ipcMain.handle('provider:testKey', (_e, id) => providerTestKey(id));
  ipcMain.handle('provider:removeKey', (_e, id) => providerRemoveKey(id));
  // Legacy zai:* channels (kept for compatibility with older front-ends).
  ipcMain.handle('zai:keyExists', () => providerKeyExists('zai'));
  ipcMain.handle('zai:saveKey', (_e, key) => providerSaveKey('zai', key));
  ipcMain.handle('zai:testKey', () => providerTestKey('zai'));
  ipcMain.handle('zai:removeKey', () => providerRemoveKey('zai'));

  ipcMain.on('refresh', () => {
    log.debug('ipc', 'refresh requested');
    if (scheduler) {
      const fired = scheduler.refreshNow();
      log.debug('ipc', `refreshNow fired: ${fired} (inFlight=${scheduler.inFlight}, queued=${scheduler.manualQueued})`);
    }
  });
  ipcMain.on('renderer-error', (_e, info) => {
    log.error('renderer', String(info && info.message || info).slice(0, 300));
  });

  // Frameless-window chrome: hide-to-tray close button and dropdown Quit.
  ipcMain.on('app-quit', () => {
    app.isQuitting = true;
    if (tray && !tray.isDestroyed()) tray.destroy();
    app.quit();
  });
  ipcMain.on('window-hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  // Clipboard for the header copy button (usage summary for agents).
  // Read-back exists for the E2E selftest roundtrip check.
  ipcMain.handle('clipboard:write', (_e, text) => {
    if (typeof text !== 'string' || !text.length || text.length > 4000) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('set-always-on-top', (_e, enabled) => {
    settings.patch({ alwaysOnTop: !!enabled });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(!!enabled);
    rebuildTrayMenu();
  });
  ipcMain.handle('launch-at-login', (_e, enabled) => { setLaunchAtLogin(!!enabled); return settings.get().launchAtLogin; });
}

// ---------------------------------------------------------------- selftest

/** Dev-only: drive the settings open/close flow and report (see README). */
async function runSettingsSelftest() {
  const js = `
    (async () => {
      const panel = document.getElementById('settings-panel');
      // Wait for a snapshot driven by a manual refresh (like clicking the
      // refresh button), so cards are populated like a real user session.
      // The pause clears the refresh debounce set by the load-time poll.
      await new Promise((r) => setTimeout(r, 2300));
      const waited = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 8000);
        window.tracker.onSnapshot(() => { clearTimeout(t); resolve(true); });
        window.tracker.refresh();
      });
      // Dropdown menu: open it, then open Settings from it.
      const menu = document.getElementById('main-menu');
      document.getElementById('btn-menu').click();
      await new Promise((r) => setTimeout(r, 200));
      const menuOpened = !menu.hidden;
      // Copy from the dropdown menu (same shared path as the header button).
      document.getElementById('menu-copy').click();
      await new Promise((r) => setTimeout(r, 300));
      const menuCopyOk = (await window.tracker.readClipboard()).startsWith('AI usage - ');
      document.getElementById('btn-settings').click();
      await new Promise((r) => setTimeout(r, 400));
      const opened = !panel.hidden;
      const displayWhileOpen = getComputedStyle(panel).display;
      // Mimic a settings interaction (fires 'change' -> patchFromUI) before Done.
      const clockSel = document.getElementById('set-clock');
      clockSel.value = '12';
      clockSel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
      document.getElementById('btn-settings-close').click();
      await new Promise((r) => setTimeout(r, 2000));
      // Copy button: click, tick, restore - including the rapid double-click
      // race (second click while the tick is still showing must not freeze
      // the icon or stop later copies).
      let copyOk = false;
      let copyRestored = false;
      let copyTwiceOk = false;
      try {
        const btnCopy = document.getElementById('btn-copy');
        const icon0 = btnCopy.textContent;
        btnCopy.click();
        await new Promise((r) => setTimeout(r, 300));
        let clip = await window.tracker.readClipboard();
        copyOk = typeof clip === 'string' && clip.startsWith('AI usage - ')
          && clip.split('\\n').length >= 2;
        btnCopy.click(); // rapid second click during the tick window
        await new Promise((r) => setTimeout(r, 300));
        clip = await window.tracker.readClipboard();
        copyTwiceOk = typeof clip === 'string' && clip.startsWith('AI usage - ');
        await new Promise((r) => setTimeout(r, 1500));
        copyRestored = btnCopy.textContent === icon0 && btnCopy.title.includes('Copy');
      } catch { copyOk = false; }
      return {
        waited,
        menuOpened,
        opened,
        displayWhileOpen,
        closedAfterDone: panel.hidden,
        displayAfterDone: getComputedStyle(panel).display,
        cardsVisible: !!document.getElementById('cards').children.length,
        cardCount: document.getElementById('cards').children.length,
        appZoom: document.getElementById('app').style.zoom || 'unset',
        fitDetail: document.getElementById('app').dataset.fit || 'none',
        peakBadge: !!document.querySelector('.peak-badge'),
        // Custom tooltip: hovering the peak badge must show it to the RIGHT
        // of the badge (dispatch synthetic mouseover, compare visual rects).
        ...(() => {
          const badge = document.querySelector('.peak-badge');
          if (!badge) return { tooltipShown: false, tooltipRight: false, tooltipTz: false };
          badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          const tip = document.getElementById('tooltip');
          const br = badge.getBoundingClientRect();
          const tr = tip.getBoundingClientRect();
          return {
            tooltipShown: tip.classList.contains('show') && tip.textContent.includes('Beijing'),
            tooltipRight: tr.left >= br.left - 1,
            tooltipTz: (() => { const l3 = tip.textContent.split('\\n')[2] || ''; return l3.includes('/') || l3.includes('local time'); })(),
          };
        })(),
        copyOk,
        copyRestored,
        copyTwiceOk,
        menuCopyOk,
        toastPresent: !!document.getElementById('toast'),
        freshnessVisible: [...document.querySelectorAll('.card')].every((card) => {
          const status = card.querySelector('.reading-status');
          return status && ['current', 'cached', 'waiting'].includes(status.textContent)
            && status.getAttribute('data-tip').includes('Source:');
        }),
        freshnessHover: (() => {
          const status = document.querySelector('.reading-status.current');
          if (!status) return false;
          status.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          const tip = document.getElementById('tooltip');
          return tip.classList.contains('show') && tip.textContent.includes('Reading age:');
        })(),
        captureUndoVisible: !!document.getElementById('btn-claude-restore'),
        readingStates: [...document.querySelectorAll('.card')].map((card) =>
          card.dataset.providerId + ':' + card.dataset.readingState),
      };
    })()`;
  try {
    const result = await mainWindow.webContents.executeJavaScript(js, true);
    log.info('selftest', JSON.stringify(result));
    const ok = result.waited && result.menuOpened && result.opened && result.closedAfterDone
      && result.displayAfterDone === 'none' && result.copyOk && result.copyRestored
      && result.copyTwiceOk && result.menuCopyOk && result.toastPresent && result.peakBadge
      && result.freshnessVisible && result.freshnessHover && result.captureUndoVisible;
    log.info('selftest', ok ? 'PASS' : 'FAIL');
    app.exit(ok ? 0 : 1);
  } catch (cause) {
    log.error('selftest', String(cause && cause.message));
    app.exit(1);
  }
}

// ---------------------------------------------------------------- screenshots

function scheduleScreenshots() {
  if (!mainWindow || screenshotTaken) return;
  screenshotTaken = true;
  const sizes = [['100', 1.0], ['150', 1.5]];
  let chain = Promise.resolve();
  for (const [name, zoom] of sizes) {
    chain = chain.then(() => new Promise((resolve) => {
      mainWindow.webContents.setZoomFactor(zoom);
      setTimeout(async () => {
        try {
          const fs = require('fs');
          fs.mkdirSync(screenshotDir, { recursive: true });
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, `mini-${name}.png`), image.toPNG());
          log.info('screenshot', `saved mini-${name}.png`);
        } catch (cause) { log.error('screenshot', cause.message); }
        resolve();
      }, 1200);
    }));
  }
  chain.then(() => { app.isQuitting = true; app.quit(); });
}
let screenshotTaken = false;
