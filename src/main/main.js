'use strict';

/**
 * AI Usage Tracker - Electron main process.
 *
 * Compact always-on-top usage panel for Codex, Claude Code, and Z.ai quota
 * windows, living in the notification area. See README.md for architecture.
 */
const path = require('path');
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

function main() {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    settings = new SettingsStore(path.join(userData, 'settings.json'));
    settings.load();
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

    scheduler = new Scheduler(pollProvidersOnce);
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

async function pollProvidersOnce() {
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
  const enabled = Object.entries(s.providers).filter(([, on]) => on).map(([id]) => id);
  const getKeyFor = (target) => async () => {
    try { return await credentials.readSecret({ target }); } catch { return null; }
  };
  const registry = createRegistry({
    zaiDeps: {
      getKey: getKeyFor(credentials.TARGET),
      baseUrl: s.zaiBaseUrl,
    },
    grokDeps: { getKey: getKeyFor('ai-usage-tracker:grok-api-key') },
    geminiDeps: { getKey: getKeyFor('ai-usage-tracker:gemini-api-key') },
    openrouterDeps: { getKey: getKeyFor('ai-usage-tracker:openrouter-api-key') },
  }).filter((p) => enabled.includes(p.id));

  const fresh = await pollAll(registry, { baseUrl: s.zaiBaseUrl });
  for (const [id, snap] of Object.entries(fresh)) {
    if (!snap.ok) {
      log.warn('poll', `${id}: ${snap.error ? snap.error.code : 'unknown'} - ${snap.error ? snap.error.message : ''}`);
    } else {
      const ws = Array.isArray(snap.windows) ? snap.windows : [];
      const meaningful = ws.filter((w) => w.kind === 'session' || w.kind === 'weekly').length;
      if (meaningful === 0) {
        const notes = Array.isArray(snap.notes) && snap.notes.length ? ` | ${snap.notes.join('; ')}` : '';
        log.warn('poll', `${id}: reachable, but no session/weekly quota windows (plan=${snap.plan || 'none'}, windows=${ws.length})${notes}`);
      }
    }
  }
  const merged = mergeWithCache(fresh, lastMerged);
  lastMerged = merged;

  // History + spike detection on ok (or cached-ok) snapshots.
  const now = Date.now();
  for (const snap of Object.values(merged)) {
    const effective = snap.ok ? snap : (snap.stale ? { ...snap, ok: true } : snap);
    if (!effective.ok) continue;
    ingestSnapshot(history, effective, now);
    for (const w of effective.windows) {
      if (w.kind !== 'session' && w.kind !== 'weekly') continue;
      if (!Number.isFinite(w.usedPercent)) continue;
      const samples = history.get(effective.providerId, w.kind);
      const alert = detectSpike(effective.providerId, w.kind, samples, {
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
  history.save();

  broadcast(merged, now);
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
    if (!p.ok) continue;
    for (const kind of ['session', 'weekly']) {
      const w = p.windows[kind];
      if (w && Number.isFinite(w.usedPercent)) max = Math.max(max, w.usedPercent);
    }
  }
  const fill = max / 100;
  rebuildTrayMenu(fill);
  if (tray) {
    const parts = snapshot.providers.filter((p) => p.ok).map((p) => {
      const s = p.windows.session ? `${Math.round(p.windows.session.usedPercent)}%` : '—';
      const w = p.windows.weekly ? `${Math.round(p.windows.weekly.usedPercent)}%` : '—';
      return `${p.title}: ${s} / ${w}`;
    });
    tray.setToolTip(parts.length ? `AI Usage\n${parts.join('\n')}` : 'AI Usage Tracker');
  }
}

// ---------------------------------------------------------------- login item

function applyLoginItemSettings() {
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
      next = settings.patch(partials || {});
      if (next.theme !== before.theme) nativeTheme.themeSource = next.theme;
      if (next.alwaysOnTop !== before.alwaysOnTop && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(next.alwaysOnTop);
      }
      if (next.intervalMinutes !== before.intervalMinutes && scheduler) {
        scheduler.start(next.intervalMinutes);
      }
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
    if (!keyTarget(id)) return null;
    try { return await credentials.secretExists({ target: keyTarget(id) }); } catch (cause) {
      log.error('credmgr', `exists check failed: ${cause.message}`);
      return null;
    }
  }
  async function providerSaveKey(id, key) {
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
        copyOk,
        copyRestored,
        copyTwiceOk,
        menuCopyOk,
        toastPresent: !!document.getElementById('toast'),
      };
    })()`;
  try {
    const result = await mainWindow.webContents.executeJavaScript(js, true);
    log.info('selftest', JSON.stringify(result));
    const ok = result.waited && result.menuOpened && result.opened && result.closedAfterDone
      && result.displayAfterDone === 'none' && result.copyOk && result.copyRestored
      && result.copyTwiceOk && result.menuCopyOk && result.toastPresent && result.peakBadge;
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
