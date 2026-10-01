'use strict';

/**
 * Pure snapshot shaping: turn the raw merged provider map into the view the
 * renderer renders. Extracted from main.js so the exact production shaping
 * (including failing providers, which have NO windows array) is unit-tested.
 */
const { providerHasSpike, describeAlert } = require('./spikes');
const { formatAge } = require('./format');
const { getZaiPeakState } = require('./peak');

const TITLES = { codex: 'Codex', claude: 'Claude', zai: 'Z.ai', grok: 'Grok', gemini: 'Gemini', openrouter: 'OpenRouter' };
const ORDER = ['codex', 'claude', 'zai', 'grok', 'gemini', 'openrouter'];

/** Providers with a known published peak/off-peak schedule. Extending
 *  peak support to another provider is one entry here + an adapter. */
const PEAK_STATES = { zai: getZaiPeakState };

function describeActiveAlert(activeAlerts, providerId) {
  for (const [key, v] of Object.entries(activeAlerts || {})) {
    if (key.startsWith(`${providerId}:`)) return describeAlert(v.alert);
  }
  return 'Usage spike detected';
}

/**
 * Shape one provider. Tolerates every snapshot variant:
 * undefined (disabled), ok:false (error, NO windows array), ok:true,
 * and cached-ok-but-stale. Must never throw.
 */
function shapeProvider(id, snap, { enabled, activeAlerts, now }) {
  // Peak/off-peak comes from published schedules, not the fetch, so it is
  // attached in every provider state (fresh boot, error, disabled).
  const peak = PEAK_STATES[id] ? PEAK_STATES[id](now) : null;
  if (!snap) {
    return {
      id, title: TITLES[id], enabled: !!enabled, ok: false,
      error: enabled ? { code: 'WAITING', message: 'Waiting for the first reading' }
        : { code: 'DISABLED', message: 'Provider disabled in Settings' },
      windows: { session: null, weekly: null }, extras: [], notes: [], spike: null, peak,
    };
  }
  const windows = Array.isArray(snap.windows) ? snap.windows : [];
  const byKind = {};
  for (const kind of ['session', 'weekly']) {
    const w = windows.find((x) => x && x.kind === kind);
    byKind[kind] = w
      ? {
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        periodSeconds: w.periodSeconds || null,
      }
      : null;
  }
  const view = {
    id,
    title: TITLES[id],
    enabled: !!enabled,
    ok: !!snap.ok,
    plan: snap.plan || null,
    stale: !!snap.stale,
    fetchedAt: snap.fetchedAt,
    staleAgeLabel: snap.stale && snap.ok ? formatAge(snap.fetchedAt, now) : null,
    source: snap.source || (Array.isArray(snap.notes) && snap.notes.includes('From Claude Code status line') ? 'claude-statusline' : null),
    error: snap.error || (snap.lastError || null),
    notes: Array.isArray(snap.notes) ? snap.notes : [],
    windows: byKind,
    extras: windows.filter((x) => x && x.kind === 'other'),
    peak,
    spike: providerHasSpike(activeAlerts, id, now)
      ? { description: describeActiveAlert(activeAlerts, id) }
      : null,
  };
  return view;
}

/** Shape the full broadcast payload. Never throws for any provider state. */
function shapeSnapshot(merged, { settings, activeAlerts = {}, now = Date.now() } = {}) {
  const profiles = settings && Array.isArray(settings.claudeProfiles) ? settings.claudeProfiles : [];
  const codexProfiles = settings && Array.isArray(settings.codexProfiles) ? settings.codexProfiles : [];
  const ids = [ORDER[0], ...codexProfiles.map((p) => p.id), ORDER[1], ...profiles.map((p) => p.id), ...ORDER.slice(2)];
  const titles = { ...TITLES, ...Object.fromEntries([...codexProfiles, ...profiles].map((p) => [p.id, p.label])) };
  const providers = ids.map((id) => {
    const inactiveClaude = settings && settings.providers.claude !== false
      && (id === 'claude' || id.startsWith('claude-profile-'))
      && id !== (settings.claudeActiveProfile || 'claude');
    const stored = (merged || {})[id];
    const snap = inactiveClaude && stored && stored.ok
      ? { ...stored, stale: true, lastError: { code: 'PAUSED', message: 'Not monitoring this Claude account; showing its last reading' } }
      : inactiveClaude
        ? { providerId: id, ok: false, error: { code: 'PAUSED', message: 'No local reading yet' } }
        : stored;
    return shapeProvider(id, snap, {
      enabled: settings ? (id.startsWith('claude-profile-') ? settings.providers.claude !== false
        : id.startsWith('codex-profile-') ? settings.providers.codex !== false : settings.providers[id] !== false) : true,
      activeAlerts,
      now,
    });
  }).map((provider) => ({ ...provider, title: titles[provider.id] || provider.title }));
  return {
    now,
    claudeActiveProfile: settings ? settings.claudeActiveProfile || 'claude' : 'claude',
    clock24: settings ? settings.clock24 !== false : true,
    percentMode: settings ? settings.percentMode : 'used',
    providers,
    lastUpdated: now,
  };
}

module.exports = { shapeSnapshot, shapeProvider, TITLES, ORDER };
