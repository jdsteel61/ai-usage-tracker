'use strict';

/**
 * Renderer: renders snapshots pushed from the main process. No network, no
 * Node APIs - all data arrives over the context-bridged IPC surface.
 * The header doubles as the frameless window's drag region and carries the
 * clock plus a time-since-update counter.
 */
(() => {
  const app = document.getElementById('app');
  const headerEl = document.getElementById('app-header');
  const cards = document.getElementById('cards');
  const clockEl = document.getElementById('header-clock');
  const menuEl = document.getElementById('main-menu');
  let settings = null;
  let snapshot = null;

  // ---- helpers (mirror main/format.js semantics; small + local) ----

  function countdown(resetsAt, now) {
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t)) return null;
    let ms = t - now;
    if (ms < 0) ms = 0;
    if (ms < 60_000) return '<1m';
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  }

  function resetClock(resetsAt, hour24) {
    const t = Date.parse(resetsAt);
    if (!Number.isFinite(t)) return null;
    const fmt = new Intl.DateTimeFormat('en-US', hour24
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { hour: '2-digit', minute: '2-digit', hour12: true });
    const full = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      ...(hour24 ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: '2-digit', minute: '2-digit', hour12: true }),
    });
    return `${fmt.format(t)} (${full.format(t)})`;
  }

  function pctClass(p) {
    if (p >= 90) return 'crit';
    if (p >= 70) return 'warn';
    return '';
  }

  function displayPercent(usedPercent) {
    if (!Number.isFinite(usedPercent)) return null;
    const base = Math.round(usedPercent);
    const value = settings && settings.percentMode === 'remaining' ? 100 - base : base;
    return `${value}%`;
  }

  // ---- header clock + time-since-update counter ----

  function ageLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 60_000) return 'now';
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  }

  let lastUpdated = null;

  // ---- toast (small non-blocking notices) ----

  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function showToast(message) {
    if (!message) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function renderClock() {
    const hour24 = !settings || settings.clock24 !== false;
    const fmt = new Intl.DateTimeFormat('en-US', hour24
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { hour: '2-digit', minute: '2-digit', hour12: true });
    const clock = fmt.format(new Date());
    const age = lastUpdated === null ? '--' : ageLabel(Date.now() - lastUpdated);
    clockEl.innerHTML = '';
    clockEl.append(document.createTextNode(`${clock} `));
    if (age !== null) {
      const span = document.createElement('span');
      span.className = 'age';
      // Amber when the data is older than twice the poll interval: something
      // is wrong upstream (provider failing) or the machine just woke up.
      const intervalMs = (settings && Number.isFinite(settings.intervalMinutes)
        ? settings.intervalMinutes : 5) * 60_000;
      if (lastUpdated !== null && Date.now() - lastUpdated > 2 * intervalMs) {
        span.classList.add('staleAge');
      }
      span.textContent = `\u00b7 ${age}`;
      clockEl.appendChild(span);
    }
    clockEl.title = lastUpdated === null
      ? 'Waiting for first update'
      : `Last updated ${fmt.format(new Date(lastUpdated))}`;
  }

  // ---- rendering ----

  function renderProvider(p) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = p.title.toUpperCase();
    head.appendChild(name);
    if (p.plan) {
      const plan = document.createElement('span');
      plan.className = 'provider-plan';
      plan.textContent = p.plan;
      head.appendChild(plan);
    }
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);
    if (p.spike) {
      const spike = document.createElement('button');
      spike.className = 'spike';
      spike.textContent = '!';
      spike.title = p.spike.description;
      spike.addEventListener('click', () => { spike.title && window.alert(spike.title); });
      head.appendChild(spike);
    }
    if (p.stale && p.ok) {
      const badge = document.createElement('span');
      badge.className = 'stale-badge';
      badge.textContent = `stale \u00b7 ${p.staleAgeLabel || ''}`.trim();
      badge.title = 'Last successful poll; provider currently unreachable or erroring';
      head.appendChild(badge);
    }
    card.appendChild(head);

    if (!p.ok) {
      const err = document.createElement('div');
      err.className = 'card-error';
      err.textContent = p.error && p.error.message ? p.error.message : 'Unavailable';
      err.title = p.error && p.error.code ? `code: ${p.error.code}` : '';
      card.appendChild(err);
    } else {
      const hasSession = p.windows && p.windows.session;
      const hasWeekly = p.windows && p.windows.weekly;
      if (hasSession) {
        card.appendChild(renderRow(p, 'session'));
      }
      if (hasWeekly) {
        card.appendChild(renderRow(p, 'weekly'));
      } else if (hasSession) {
        // Session-capable provider without a weekly window: placeholder keeps
        // the two-row rhythm (e.g. plan variants with no weekly quota).
        card.appendChild(renderRow(p, 'weekly'));
      }
      // Providers with no quota windows at all (e.g. Gemini) show notes only.
      for (const note of p.notes || []) {
        const n = document.createElement('div');
        n.className = 'card-note';
        n.textContent = note;
        card.appendChild(n);
      }
    }
    return card;
  }

  function renderRow(p, kind) {
    const row = document.createElement('div');
    row.className = 'wrow';
    const hour24 = !settings || settings.clock24 !== false;
    const now = snapshot ? snapshot.now : Date.now();

    const label = document.createElement('span');
    label.className = 'wlabel';
    label.textContent = kind === 'session' ? (p.windows.session && p.windows.session.label) || '5 hr' : 'Week';
    row.appendChild(label);

    const w = p.windows ? p.windows[kind] : null;
    if (!w || !Number.isFinite(w.usedPercent)) {
      // Provider does not expose this window: '—' with an explanatory tooltip.
      for (let i = 0; i < 3; i++) {
        const cell = document.createElement('span');
        cell.className = 'unknown';
        cell.textContent = '\u2014';
        cell.title = `${p.title} does not report a ${kind === 'session' ? 'session (5-hour)' : 'weekly'} quota window`;
        row.appendChild(cell);
      }
      return row;
    }

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = `bar-fill ${pctClass(w.usedPercent)}`;
    fill.style.width = `${Math.min(100, Math.max(0, w.usedPercent))}%`;
    bar.appendChild(fill);
    row.appendChild(bar);

    const pct = document.createElement('span');
    pct.className = 'wpct';
    pct.textContent = displayPercent(w.usedPercent);
    row.appendChild(pct);

    const cd = document.createElement('span');
    cd.className = 'wcountdown';
    const cdText = countdown(w.resetsAt, now);
    if (cdText === null) {
      cd.textContent = '\u2014';
      cd.title = 'Reset time unknown';
    } else {
      cd.textContent = cdText;
      const clock = resetClock(w.resetsAt, hour24);
      if (clock) cd.title = `Resets at ${clock}`;
    }
    row.appendChild(cd);
    // Hover detail for the whole row: used vs remaining + reset time.
    const used = Math.round(w.usedPercent);
    row.title = `${w.label || kind}: ${used}% used \u00b7 ${100 - used}% remaining${
      w.resetsAt ? ` \u00b7 resets ${cd.title && cd.title.startsWith('Resets') ? cd.title.slice(10) : ''}` : ' \u00b7 does not reset'}`;
    return row;
  }

  // ---- zoom-to-fit: the whole UI scales so every enabled provider fits ----

  const { computeFitScale } = (window.AITRACKER_SCALE || { computeFitScale: () => 1 });
  let fitQueued = false;

  function fitUI() {
    fitQueued = false;
    // Measure the natural (unzoomed) content size: width pinned to the 300px
    // design width, height auto, so the measurement can never feed back on
    // the previously applied scale (box sized innerW/s x innerH/s).
    app.style.zoom = 1;
    app.style.width = '300px';
    app.style.height = '';
    const needH = headerEl.offsetHeight + cards.scrollHeight + 3;
    const needW = 300;
    const s = computeFitScale(window.innerWidth, window.innerHeight, needW, needH, { min: 0.5, max: 1.8 });
    app.dataset.fit = `${needW}x${Math.round(needH)}->${s.toFixed(2)}`;
    app.style.zoom = s;
    app.style.width = `${window.innerWidth / s}px`;
    app.style.height = `${window.innerHeight / s}px`;
  }

  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(fitUI);
  }
  window.addEventListener('resize', queueFit);

  function render(snap) {
    snapshot = snap;
    lastUpdated = snap ? snap.lastUpdated : lastUpdated;
    cards.textContent = '';
    if (!snap) return;
    let rendered = 0;
    for (const p of snap.providers) {
      if (!p.enabled) continue;
      cards.appendChild(renderProvider(p));
      rendered++;
    }
    if (!rendered) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'All providers are off. Open \u2699 Settings \u2192 Providers to enable some.';
      cards.appendChild(hint);
    }
    renderClock();
    queueFit();
  }

  // ---- dropdown menu ----

  const btnMenu = document.getElementById('btn-menu');
  const ontopEl = document.getElementById('menu-ontop');
  const loginEl = document.getElementById('menu-login');

  function closeMenu() { menuEl.hidden = true; }

  btnMenu.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menuEl.hidden) { closeMenu(); return; }
    try {
      settings = await window.tracker.getSettings();
      ontopEl.checked = settings.alwaysOnTop;
      loginEl.checked = settings.launchAtLogin;
    } catch { /* keep last known */ }
    menuEl.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== btnMenu) closeMenu();
  });
  menuEl.addEventListener('click', (e) => {
    if (e.target.closest('button.menu-item:not(.check)')) closeMenu();
  });
  ontopEl.addEventListener('change', () => window.tracker.saveSettings({ alwaysOnTop: ontopEl.checked }));
  loginEl.addEventListener('change', () => window.tracker.setLaunchAtLogin(loginEl.checked));
  document.getElementById('menu-copy').addEventListener('click', () => { copyNow(); });
  document.getElementById('menu-refresh').addEventListener('click', () => window.tracker.refresh());
  document.getElementById('menu-quit').addEventListener('click', () => window.tracker.quitApp());
  document.getElementById('btn-close').addEventListener('click', () => window.tracker.hideWindow());

  // ---- copy usage summary (for sharing with agents) ----

  const btnCopy = document.getElementById('btn-copy');
  const COPY_ICON = btnCopy.textContent; // captured once; restore target is constant
  const COPY_TITLE = 'Copy usage summary for agents';
  let copyTimer = null;

  async function copyNow() {
    const builder = window.AITRACKER_SUMMARY || { buildUsageSummary: () => '' };
    const text = builder.buildUsageSummary(snapshot, {
      hour24: !settings || settings.clock24 !== false,
      now: Date.now(),
    });
    if (!text || !text.includes('\n')) {
      showToast('No usage data yet - nothing to copy');
      return;
    }
    try {
      await window.tracker.copyText(text);
      btnCopy.textContent = '\u2713';
      btnCopy.title = 'Copied';
      clearTimeout(copyTimer);
      // Restore to the constant original glyph (never re-read textContent,
      // which may already be the tick from a rapid second click).
      copyTimer = setTimeout(() => {
        btnCopy.textContent = COPY_ICON;
        btnCopy.title = COPY_TITLE;
      }, 1200);
    } catch {
      btnCopy.title = 'Copy failed';
      showToast('Copy failed');
    }
  }

  btnCopy.addEventListener('click', copyNow);

  // ---- settings overlay ----

  const panel = document.getElementById('settings-panel');
  const PROVIDER_IDS = ['codex', 'claude', 'zai', 'grok', 'gemini', 'openrouter'];

  async function loadSettingsIntoUI() {
    settings = await window.tracker.getSettings();
    for (const id of PROVIDER_IDS) {
      document.getElementById(`set-prov-${id}`).checked = settings.providers[id] !== false;
    }
    document.getElementById('set-interval').value = settings.intervalMinutes;
    document.getElementById('set-percentmode').value = settings.percentMode;
    document.getElementById('set-clock').value = settings.clock24 ? '24' : '12';
    document.getElementById('set-theme').value = settings.theme;
    document.getElementById('set-ontop').checked = settings.alwaysOnTop;
    document.getElementById('set-login').checked = settings.launchAtLogin;
    document.getElementById('set-spike-abs').value = settings.spikeAbsolutePoints;
    document.getElementById('set-spike-rel-min').value = settings.spikeRelativePoints;
    document.getElementById('set-spike-rel-mult').value = settings.spikeRelativeMultiplier;
    document.getElementById('set-spike-minutes').value = settings.spikeAlertMinutes;
    document.getElementById('set-zai-url').value = settings.zaiBaseUrl;
    await refreshKeyStatuses();
  }

  function patchFromUI() {
    const providers = {};
    for (const id of PROVIDER_IDS) providers[id] = document.getElementById(`set-prov-${id}`).checked;
    return window.tracker.saveSettings({
      providers,
      intervalMinutes: Number(document.getElementById('set-interval').value),
      percentMode: document.getElementById('set-percentmode').value,
      clock24: document.getElementById('set-clock').value === '24',
      theme: document.getElementById('set-theme').value,
      alwaysOnTop: document.getElementById('set-ontop').checked,
      launchAtLogin: document.getElementById('set-login').checked,
      spikeAbsolutePoints: Number(document.getElementById('set-spike-abs').value),
      spikeRelativePoints: Number(document.getElementById('set-spike-rel-min').value),
      spikeRelativeMultiplier: Number(document.getElementById('set-spike-rel-mult').value),
      spikeAlertMinutes: Number(document.getElementById('set-spike-minutes').value),
      zaiBaseUrl: document.getElementById('set-zai-url').value,
    }).then((s) => { settings = s; });
  }

  document.getElementById('btn-settings').addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadSettingsIntoUI();
  });
  document.getElementById('btn-settings-close').addEventListener('click', async () => {
    // Always return to the tracker; a failed save is logged and shown, but
    // must never wedge the panel open.
    try {
      await patchFromUI();
    } catch (cause) {
      console.error('settings save failed:', cause);
      const status = document.getElementById('zai-status');
      if (status) status.textContent = 'Settings save failed (see log)';
      window.tracker.reportError(`settings save failed: ${cause && cause.message}`);
    }
    panel.hidden = true;
  });
  panel.addEventListener('change', () => { patchFromUI(); });

  document.getElementById('set-login').addEventListener('change', (e) => {
    window.tracker.setLaunchAtLogin(e.target.checked);
  });

  document.getElementById('btn-refresh').addEventListener('click', (e) => {
    e.target.disabled = true;
    setTimeout(() => { e.target.disabled = false; }, 2000); // debounced in main too
    window.tracker.refresh();
  });

  // ---- per-provider API key management ----
  // Keys live only in Windows Credential Manager (main process handles the
  // confirmation dialogs); the renderer never persists them anywhere.

  const KEY_PROVIDERS = [
    { id: 'zai', label: 'Z.ai', url: true },
    { id: 'grok', label: 'Grok (xAI)' },
    { id: 'gemini', label: 'Gemini (AI Studio)' },
    { id: 'openrouter', label: 'OpenRouter' },
  ];
  const keyEls = {};

  function buildApiKeyUI() {
    const host = document.getElementById('api-keys');
    for (const p of KEY_PROVIDERS) {
      const block = document.createElement('div');
      block.className = 'api-key-block';

      const title = document.createElement('div');
      title.className = 'row';
      title.textContent = p.label;
      block.appendChild(title);

      if (p.url) {
        const urlRow = document.createElement('label');
        urlRow.className = 'row keyrow';
        urlRow.append(document.createTextNode('API base URL'));
        const urlInput = document.createElement('input');
        urlInput.type = 'url';
        urlInput.id = 'set-zai-url';
        urlInput.spellcheck = false;
        urlRow.appendChild(urlInput);
        block.appendChild(urlRow);
      }

      const keyRow = document.createElement('label');
      keyRow.className = 'row keyrow';
      keyRow.append(document.createTextNode('API key'));
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.id = `set-${p.id}-key`;
      keyInput.placeholder = 'Credential Manager';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyRow.appendChild(keyInput);
      block.appendChild(keyRow);

      const actions = document.createElement('div');
      actions.className = 'row api-key-actions';
      const save = document.createElement('button');
      save.className = 'small-btn'; save.textContent = 'Store key';
      const test = document.createElement('button');
      test.className = 'small-btn'; test.textContent = 'Test';
      const remove = document.createElement('button');
      remove.className = 'small-btn'; remove.textContent = 'Remove';
      const status = document.createElement('span');
      status.className = 'hint'; status.id = `${p.id}-status`;
      actions.append(save, test, remove, status);
      block.appendChild(actions);

      save.addEventListener('click', async () => {
        const key = keyInput.value;
        const stat = status;
        if (!key) { stat.textContent = 'Enter a key first'; return; }
        const res = await window.tracker.providerSaveKey(p.id, key);
        stat.textContent = res.ok ? 'Key stored' : (res.error || 'Failed');
        if (res.ok) keyInput.value = '';
        refreshKeyStatuses();
      });
      test.addEventListener('click', async () => {
        status.textContent = 'Testing\u2026';
        const res = await window.tracker.providerTestKey(p.id);
        status.textContent = res.ok
          ? `OK${res.plan ? ` (${res.plan})` : ''}, ${res.windows} window(s)`
          : (res.error || 'Failed');
      });
      remove.addEventListener('click', async () => {
        const res = await window.tracker.providerRemoveKey(p.id);
        status.textContent = res.ok ? 'Key removed' : (res.error || 'Failed');
        refreshKeyStatuses();
      });

      keyEls[p.id] = { status };
      host.appendChild(block);
    }
  }

  async function refreshKeyStatuses() {
    for (const p of KEY_PROVIDERS) {
      const el = keyEls[p.id] && keyEls[p.id].status;
      if (!el) continue;
      try {
        const exists = await window.tracker.providerKeyExists(p.id);
        el.textContent = exists === null ? 'Credential Manager unavailable' : (exists ? 'Key stored' : 'No key stored');
      } catch {
        el.textContent = 'Credential Manager unavailable';
      }
    }
  }

  buildApiKeyUI();

  // ---- wiring ----

  window.tracker.onSnapshot((snap) => {
    settings = { ...(settings || {}), clock24: snap.clock24, percentMode: snap.percentMode };
    try {
      render(snap);
    } catch (cause) {
      console.error('render failed:', cause);
      window.tracker.reportError(`render failed: ${cause && cause.message}`);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!panel.hidden) panel.hidden = true;
      else closeMenu();
    }
  });

  loadSettingsIntoUI();
  renderClock();
  setInterval(renderClock, 5_000); // clock + update counter
  queueFit(); // size #app before the first snapshot lands
})();
