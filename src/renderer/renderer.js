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

  // ---- custom tooltip (native titles can't be positioned or styled) ----

  const tipEl = document.getElementById('tooltip');

  function hideTip() {
    tipEl.classList.remove('show');
    tipEl.textContent = '';
  }

  /** Place the tooltip to the RIGHT of `target` (shrinking to fit), clamped. */
  function placeTip(target) {
    const zoom = parseFloat(getComputedStyle(app).zoom) || 1;
    const r = target.getBoundingClientRect();
    const availW = window.innerWidth / zoom;
    const availH = window.innerHeight / zoom;
    const left0 = r.right / zoom;
    const roomRight = availW - left0 - 8;
    let left;
    if (roomRight >= 110) {
      // Enough room right of the anchor: shrink to fit and open rightward.
      tipEl.style.maxWidth = `${Math.min(280, roomRight)}px`;
      left = left0 + 6;
    } else {
      // Not enough room: full-width tooltip clamped to the window.
      tipEl.style.maxWidth = `${Math.min(280, availW - 8)}px`;
      left = Math.max(4, availW - tipEl.offsetWidth - 4);
    }
    let top = r.top / zoom - 2;
    const maxTop = availH - tipEl.offsetHeight - 4;
    if (top > maxTop) top = Math.max(4, r.top / zoom - tipEl.offsetHeight - 4);
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[data-tip]');
    if (!target) { hideTip(); return; }
    const text = target.getAttribute('data-tip');
    if (!text) { hideTip(); return; }
    tipEl.textContent = text;
    tipEl.classList.add('show');
    placeTip(target);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('[data-tip]')) hideTip();
  });

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
      : `Last panel update ${fmt.format(new Date(lastUpdated))}; each card shows its own reading freshness`;
  }

  // ---- rendering ----

  function renderProvider(p) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.providerId = p.id;
    const isClaude = p.id === 'claude' || p.id.startsWith('claude-profile-');

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
    if (p.peak) {
      const hour24 = !settings || settings.clock24 !== false;
      const timeOpt = hour24
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { hour: '2-digit', minute: '2-digit', hour12: true };
      const fmtDayTime = (ms) => new Intl.DateTimeFormat('en-US', { weekday: 'short', ...timeOpt }).format(new Date(ms));
      const badge = document.createElement('span');
      const on = p.peak.mode === 'peak';
      badge.className = `peak-badge ${on ? 'on' : 'off'}`;
      badge.textContent = on ? 'PEAK' : 'OFF-PEAK';
      // Rich tooltip: meaning + Beijing rule + the same window in the user's
      // own timezone (representative current/next window, DST-aware via Intl).
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
      const lines = [
        on ? 'PEAK: full credit cost per call' : 'OFF-PEAK: calls cost 50% of the base credit',
        'Z.ai peak window: Mon-Fri 14:00-18:00 Beijing (UTC+8)',
      ];
      const repStart = on ? Date.parse(p.peak.endsAt) - 4 * 3600_000 : Date.parse(p.peak.nextStartAt);
      if (Number.isFinite(repStart)) {
        lines.push(`= ${fmtDayTime(repStart)} - ${fmtDayTime(repStart + 4 * 3600_000)} ${tz}`);
      }
      if (on && p.peak.endsAt) lines.push(`Peak ends ${fmtDayTime(Date.parse(p.peak.endsAt))} ${tz}`);
      else if (p.peak.nextStartAt) lines.push(`Peak starts ${fmtDayTime(Date.parse(p.peak.nextStartAt))} ${tz}`);
      badge.setAttribute('data-tip', lines.join('\n'));
      head.appendChild(badge);
    }
    const source = document.createElement('span');
    source.className = 'card-source';
    head.appendChild(source);
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);
    if (p.spike) {
      const spike = document.createElement('button');
      spike.className = 'spike';
      spike.textContent = '!';
      spike.setAttribute('data-tip', [
        'Usage spike alert',
        'Raised when a quota jumps sharply within one polling interval -',
        'often a runaway agent loop burning through the plan.',
        '',
        `Event: ${p.spike.description}`,
      ].join('\n'));
      spike.addEventListener('click', () => showToast(p.spike.description));
      head.appendChild(spike);
    }
    const indicator = document.createElement('span');
    indicator.className = 'reading-status';
    head.appendChild(indicator);
    card.appendChild(head);
    updateReadingStatus(card, p);

    if (isClaude && p.account) {
      const account = document.createElement('div');
      account.className = 'card-note account-identity';
      account.textContent = p.account.identity?.email || 'Account identity unknown';
      account.setAttribute('data-tip', window.AITRACKER_SUMMARY.accountDetail(p));
      card.appendChild(account);
    }
    if (p.accountWarning) {
      const warning = document.createElement('div');
      warning.className = 'card-note account-warning';
      warning.textContent = p.accountWarning;
      card.appendChild(warning);
    }

    if (!p.ok) {
      const err = document.createElement('div');
      err.className = 'card-error';
      err.textContent = isClaude
        ? p.error?.code === 'NO_AUTH' ? 'API login rejected — sign in locally' : p.error?.code === 'HTTP_429' ? 'API rate limited' : 'Waiting for usage'
        : p.error && p.error.message ? p.error.message : 'Unavailable';
      if (isClaude) err.setAttribute('data-tip', p.error?.message || 'Use Claude Code to capture usage');
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
        if (isClaude && (note === 'From Claude Code status line' || note === 'From Claude usage API')) continue;
        const n = document.createElement('div');
        n.className = 'card-note';
        n.textContent = note;
        card.appendChild(n);
      }
    }
    return card;
  }

  function updateReadingStatus(card, p) {
    const status = window.AITRACKER_SUMMARY.readingStatus(p, {
      now: Date.now(), intervalMinutes: settings?.intervalMinutes || 5,
      hour24: settings?.clock24 !== false,
    });
    const sourceEl = card.querySelector('.card-source');
    if (sourceEl) sourceEl.textContent = p.ok ? window.AITRACKER_SUMMARY.sourceLabel(p, Date.now()) : '';
    const indicator = card.querySelector('.reading-status');
    indicator.className = `reading-status ${status.state}`;
    indicator.textContent = status.label;
    indicator.setAttribute('data-tip', status.detail);
    indicator.setAttribute('aria-label', status.detail);
    card.dataset.readingState = status.state;
  }

  function tickReadings() {
    renderClock();
    if (!snapshot) return;
    // Update in place so the compact controls and hovered cards stay stable.
    for (const card of cards.querySelectorAll('.card')) {
      const p = snapshot.providers.find((provider) => provider.id === card.dataset.providerId);
      if (p) updateReadingStatus(card, p);
      for (const cd of card.querySelectorAll('.wcountdown')) {
        const expired = Date.parse(cd.dataset.resetsAt) <= Date.now();
        cd.closest('.wrow').classList.toggle('expired', expired);
        cd.textContent = expired ? 'ended' : countdown(cd.dataset.resetsAt, Date.now()) || '\u2014';
        const clock = resetClock(cd.dataset.resetsAt, settings?.clock24 !== false);
        cd.title = clock ? expired ? `Reset passed ${clock}; showing the previous window` : `Resets at ${clock}` : 'Reset time unknown';
        const row = cd.closest('.wrow');
        row.querySelector('.wpct').textContent = expired ? '?' : row.dataset.percent;
        row.title = `${expired ? row.dataset.historicalDetail : row.dataset.usageDetail} \u00b7 ${cd.dataset.resetsAt ? cd.title : 'does not reset'}`;
      }
    }
  }

  function renderRow(p, kind) {
    const row = document.createElement('div');
    row.className = 'wrow';
    const hour24 = !settings || settings.clock24 !== false;
    const now = Date.now();

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
    cd.dataset.resetsAt = w.resetsAt || '';
    const expired = Date.parse(w.resetsAt) <= now;
    pct.textContent = expired ? '?' : displayPercent(w.usedPercent);
    row.dataset.percent = displayPercent(w.usedPercent);
    row.classList.toggle('expired', expired);
    const cdText = expired ? 'ended' : countdown(w.resetsAt, now);
    if (cdText === null) {
      cd.textContent = '\u2014';
      cd.title = 'Reset time unknown';
    } else {
      cd.textContent = cdText;
      const clock = resetClock(w.resetsAt, hour24);
      if (clock) cd.title = expired ? `Reset passed ${clock}; showing the previous window` : `Resets at ${clock}`;
    }
    row.appendChild(cd);
    // Hover detail for the whole row: used vs remaining + reset time.
    const used = Math.round(w.usedPercent);
    row.dataset.usageDetail = `${w.label || kind}: ${used}% used \u00b7 ${100 - used}% remaining`;
    row.dataset.historicalDetail = `${w.label || kind}: current usage unknown; last window ${used}% used`;
    row.title = `${expired ? row.dataset.historicalDetail : row.dataset.usageDetail} \u00b7 ${w.resetsAt ? cd.title : 'does not reset'}`;
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
    hideTip(); // hovered elements are rebuilt below; avoid a stale tooltip
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
      intervalMinutes: settings?.intervalMinutes || 5,
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
  const PROVIDER_IDS = ['codex', 'claude', 'zai', 'grok', 'gemini', 'openrouter', 'muse'];

  // Tabs: one focused pane each. The choice lives in memory, so reopening
  // Settings returns to the last tab.
  const tabButtons = [...panel.querySelectorAll('.tab')];
  let activeTab = tabButtons[0].dataset.tab;

  function showTab(name) {
    activeTab = name;
    for (const tab of tabButtons) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
    }
    panel.querySelector('.settings-scroll').scrollTop = 0;
  }
  for (const tab of tabButtons) tab.addEventListener('click', () => showTab(tab.dataset.tab));
  panel.querySelector('.settings-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabButtons.findIndex((tab) => tab.dataset.tab === activeTab);
    const next = tabButtons[(i + (e.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
    showTab(next.dataset.tab);
    next.focus();
  });
  showTab(activeTab);

  // "i" toggles: longer notes (safety details, alert rules) stay folded
  // until asked for.
  for (const button of panel.querySelectorAll('.info')) {
    const note = document.getElementById(button.getAttribute('aria-controls'));
    button.addEventListener('click', () => {
      note.hidden = !note.hidden;
      button.setAttribute('aria-expanded', String(!note.hidden));
    });
  }
  // A click starts an action or a dialog; drop any hover tip it would leave behind.
  panel.addEventListener('click', hideTip);

  // Hover tips for the compact Claude account controls; the tab's "i" note
  // carries the same details in full.
  const CLAUDE_TIPS = {
    capture: 'Enable capture: wraps Claude Code\'s status-line command and saves only usage percentages and reset times locally. Needs Node.js on PATH.',
    restore: 'Undo capture: restores the previous status line if unchanged. Removing a profile or quitting does not undo capture.',
    topUp: 'Off by default. When local capture is over 25 minutes old, read this profile\'s saved login (read-only) and ask the Claude usage API. Rate-budgeted; never refreshes tokens.',
    verify: 'Verify account: check the identity attached to this profile\'s saved login via the Claude API (same rate budget; lasts this session). Enable API top-up first.',
    remove: 'Stop tracking this profile. This does not undo capture, so undo first.',
  };
  document.getElementById('btn-claude-capture').setAttribute('data-tip', CLAUDE_TIPS.capture);
  document.getElementById('btn-claude-restore').setAttribute('data-tip', CLAUDE_TIPS.restore);

  function smallButton(text, tip) {
    const button = document.createElement('button');
    button.className = 'small-btn';
    button.textContent = text;
    if (tip) button.setAttribute('data-tip', tip);
    return button;
  }

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
    renderSubscriptionProfiles('codex', settings.codexProfiles || []);
    renderSubscriptionProfiles('claude', settings.claudeProfiles || []);
    renderDefaultApiTopUp();
    await refreshKeyStatuses();
  }

  function renderSubscriptionProfiles(provider, profiles) {
    const host = document.getElementById(`${provider}-profiles-list`);
    host.replaceChildren();
    for (const profile of profiles) {
      const name = document.createElement('span');
      name.textContent = profile.label;
      name.setAttribute('data-tip', profile.configDir);
      const remove = smallButton('Remove', provider === 'claude' ? CLAUDE_TIPS.remove : 'Stop tracking this profile');
      remove.addEventListener('click', async () => {
        settings = await window.tracker.removeSubscriptionProfile(provider, profile.id);
        renderSubscriptionProfiles(provider, settings[`${provider}Profiles`] || []);
        window.tracker.refresh();
      });
      if (provider !== 'claude') {
        const row = document.createElement('div');
        row.className = 'row profile-row';
        row.append(name, remove);
        host.appendChild(row);
        continue;
      }
      // Claude: the same compact card as "This PC" - name and account
      // summary, then the actions on one line.
      name.className = 'account-name';
      const head = document.createElement('div');
      head.className = 'account-head';
      head.append(name, accountDiagnostics(profile.id), remove);
      const capture = smallButton('Capture', CLAUDE_TIPS.capture);
      capture.addEventListener('click', () => enableCapture(profile.id, capture));
      const restore = smallButton('Undo', CLAUDE_TIPS.restore);
      restore.addEventListener('click', () => restoreCapture(profile.id, restore));
      const actions = document.createElement('div');
      actions.className = 'account-actions';
      actions.append(capture, restore, apiTopUpLabel(profile.id), verifyAccountButton(profile.id));
      const card = document.createElement('div');
      card.className = 'account';
      card.append(head, actions);
      host.appendChild(card);
    }
  }

  /** Opt-in checkbox; the main process asks for confirmation before enabling. */
  function apiTopUpLabel(id) {
    const label = document.createElement('label');
    label.className = 'api-topup';
    label.setAttribute('data-tip', CLAUDE_TIPS.topUp);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!(settings.claudeApiTopUp && settings.claudeApiTopUp[id]);
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        const result = await window.tracker.setClaudeApiTopUp(id, box.checked);
        if (result.ok) settings = result.settings;
        else if (!result.canceled) showToast(result.error || 'Could not change API top-up');
        box.checked = !!(settings.claudeApiTopUp && settings.claudeApiTopUp[id]);
      } catch { showToast('Could not change API top-up'); }
      finally { box.disabled = false; }
    });
    label.append(box, ' API top-up');
    return label;
  }

  function renderDefaultApiTopUp() {
    const host = document.getElementById('claude-default-topup');
    host.replaceChildren(apiTopUpLabel('claude'));
    const row = document.getElementById('btn-claude-capture').parentElement;
    if (!document.getElementById('btn-claude-verify')) {
      const button = verifyAccountButton('claude');
      button.id = 'btn-claude-verify';
      row.appendChild(button);
    }
    const detail = document.getElementById('claude-default-account');
    detail.replaceChildren(accountDiagnostics('claude'));
  }

  function verifyAccountButton(id) {
    const button = smallButton('Verify', CLAUDE_TIPS.verify);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await window.tracker.verifyClaudeAccount(id);
        showToast(result.ok ? 'Account verified via Claude API' : result.error);
      } catch { showToast('Could not verify Claude account'); }
      finally { button.disabled = false; }
    });
    return button;
  }

  /** One-line account summary; hover shows the full diagnostics, click unfolds them in place. */
  function accountDiagnostics(id) {
    const line = document.createElement('button');
    line.className = 'account-diagnostics';
    line.dataset.accountId = id;
    line.setAttribute('aria-expanded', 'false');
    line.addEventListener('click', () => {
      line.setAttribute('aria-expanded', String(line.classList.toggle('open')));
      updateAccountDiagnostics(line);
    });
    updateAccountDiagnostics(line);
    return line;
  }

  function accountSummary(provider) {
    if (!provider) return 'Waiting for account details';
    if (!provider.account) return 'No account details';
    const identity = provider.account.identity;
    if (!identity) return 'Identity unknown';
    return `${identity.email || identity.accountId} \u00b7 ${identity.source === 'api' ? 'verified' : 'unverified'}`;
  }

  function updateAccountDiagnostics(line) {
    const provider = snapshot?.providers.find((p) => p.id === line.dataset.accountId);
    const detail = provider ? window.AITRACKER_SUMMARY.accountDetail(provider) : '';
    const open = line.classList.contains('open') && !!detail;
    const warn = !!(provider && (provider.accountWarning || provider.account?.verificationError));
    line.textContent = open ? detail : `${warn ? '\u26a0 ' : ''}${accountSummary(provider)}`;
    line.classList.toggle('warn', warn);
    line.disabled = !detail;
    if (detail && !open) line.setAttribute('data-tip', detail);
    else line.removeAttribute('data-tip');
  }

  async function enableCapture(id, button) {
    button.disabled = true;
    try {
      const result = await window.tracker.enableClaudeCapture(id);
      if (!result.canceled) showToast(result.ok ? 'Capture enabled. Use Claude Code to update usage.' : result.error);
    } catch { showToast('Could not enable Claude capture'); }
    finally { button.disabled = false; }
  }
  document.getElementById('btn-claude-capture').addEventListener('click', (e) => enableCapture('claude', e.currentTarget));

  async function restoreCapture(id, button) {
    button.disabled = true;
    try {
      const result = await window.tracker.restoreClaudeCapture(id);
      if (!result.canceled) showToast(result.ok
        ? 'Capture disabled. Previous status line restored; cached readings kept.'
        : result.error);
    } catch { showToast('Could not undo Claude capture'); }
    finally { button.disabled = false; }
  }
  document.getElementById('btn-claude-restore').addEventListener('click', (e) => restoreCapture('claude', e.currentTarget));

  for (const provider of ['codex', 'claude']) {
    document.getElementById(`btn-${provider}-profile-add`).addEventListener('click', async () => {
      const result = await window.tracker.addSubscriptionProfile(provider);
      if (result.ok) {
        settings = result.settings;
        renderSubscriptionProfiles(provider, settings[`${provider}Profiles`] || []);
        window.tracker.refresh();
      } else if (!result.canceled) {
        showToast(result.error || `Could not add ${provider} profile`);
      }
    });
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

  /** Short status beside the provider name; a long error stays readable on hover. */
  function setKeyStatus(el, text, tone = '') {
    el.textContent = text;
    el.title = text;
    el.className = tone ? `key-status ${tone}` : 'key-status';
  }

  function buildApiKeyUI() {
    const host = document.getElementById('api-keys');
    for (const p of KEY_PROVIDERS) {
      const block = document.createElement('div');
      block.className = 'key-block';

      const head = document.createElement('div');
      head.className = 'key-head';
      const name = document.createElement('span');
      name.className = 'key-name';
      name.textContent = p.label;
      const status = document.createElement('span');
      status.className = 'key-status'; status.id = `${p.id}-status`;
      head.append(name, status);
      block.appendChild(head);

      if (p.url) {
        const urlRow = document.createElement('label');
        urlRow.className = 'key-row';
        const urlLabel = document.createElement('span');
        urlLabel.className = 'key-label';
        urlLabel.textContent = 'Base URL';
        const urlInput = document.createElement('input');
        urlInput.type = 'url';
        urlInput.id = 'set-zai-url';
        urlInput.spellcheck = false;
        urlRow.append(urlLabel, urlInput);
        block.appendChild(urlRow);
      }

      const keyRow = document.createElement('div');
      keyRow.className = 'key-row';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.id = `set-${p.id}-key`;
      keyInput.placeholder = 'API key';
      keyInput.setAttribute('aria-label', `${p.label} API key`);
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      const save = smallButton('Store', 'Store this key in Windows Credential Manager (asks first)');
      const test = smallButton('Test', 'Test the stored key with the provider (asks first)');
      const remove = smallButton('Remove', 'Delete the stored key (asks first)');
      keyRow.append(keyInput, save, test, remove);
      block.appendChild(keyRow);

      save.addEventListener('click', async () => {
        const key = keyInput.value;
        if (!key) { setKeyStatus(status, 'Enter a key first', 'warn'); return; }
        const res = await window.tracker.providerSaveKey(p.id, key);
        if (res.ok) { setKeyStatus(status, 'Key stored', 'ok'); keyInput.value = ''; } else setKeyStatus(status, res.error || 'Failed', 'warn');
        refreshKeyStatuses();
      });
      test.addEventListener('click', async () => {
        setKeyStatus(status, 'Testing\u2026');
        const res = await window.tracker.providerTestKey(p.id);
        if (res.ok) setKeyStatus(status, `OK${res.plan ? ` (${res.plan})` : ''}, ${res.windows} window(s)`, 'ok');
        else setKeyStatus(status, res.error || 'Failed', 'warn');
      });
      remove.addEventListener('click', async () => {
        const res = await window.tracker.providerRemoveKey(p.id);
        if (res.ok) setKeyStatus(status, 'Key removed'); else setKeyStatus(status, res.error || 'Failed', 'warn');
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
        if (exists === null) setKeyStatus(el, 'Credential Manager unavailable', 'warn');
        else setKeyStatus(el, exists ? 'Key stored' : 'No key stored', exists ? 'ok' : '');
      } catch {
        setKeyStatus(el, 'Credential Manager unavailable', 'warn');
      }
    }
  }

  buildApiKeyUI();

  // ---- wiring ----

  window.tracker.onSnapshot((snap) => {
    settings = { ...(settings || {}), clock24: snap.clock24, percentMode: snap.percentMode };
    try {
      render(snap);
      document.querySelectorAll('.account-diagnostics').forEach(updateAccountDiagnostics);
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
  setInterval(tickReadings, 5_000); // clock, reading freshness, reset boundaries
  queueFit(); // size #app before the first snapshot lands
})();
