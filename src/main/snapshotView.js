'use strict';

/**
 * Pure snapshot shaping: turn the raw merged provider map into the view the
 * renderer renders. Extracted from main.js so the exact production shaping
 * (including failing providers, which have NO windows array) is unit-tested.
 */
const { providerHasSpike, describeAlert } = require('./spikes');
const { formatAge } = require('./format');

const TITLES = { codex: 'Codex', claude: 'Claude', zai: 'Z.ai', grok: 'Grok', gemini: 'Gemini', openrouter: 'OpenRouter' };
const ORDER = ['codex', 'claude', 'zai', 'grok', 'gemini', 'openrouter'];

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
  if (!snap) {
    return {
      id, title: TITLES[id], enabled: !!enabled, ok: false,
      error: { code: 'DISABLED', message: 'Provider disabled in Settings' },
      windows: { session: null, weekly: null }, extras: [], notes: [], spike: null,
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
    error: snap.error || (snap.lastError || null),
    notes: Array.isArray(snap.notes) ? snap.notes : [],
    windows: byKind,
    extras: windows.filter((x) => x && x.kind === 'other'),
    spike: providerHasSpike(activeAlerts, id, now)
      ? { description: describeActiveAlert(activeAlerts, id) }
      : null,
  };
  return view;
}

/** Shape the full broadcast payload. Never throws for any provider state. */
function shapeSnapshot(merged, { settings, activeAlerts = {}, now = Date.now() } = {}) {
  const providers = ORDER.map((id) => shapeProvider(id, (merged || {})[id], {
    enabled: settings ? settings.providers[id] !== false : true,
    activeAlerts,
    now,
  }));
  return {
    now,
    clock24: settings ? settings.clock24 !== false : true,
    percentMode: settings ? settings.percentMode : 'used',
    providers,
    lastUpdated: now,
  };
}

module.exports = { shapeSnapshot, shapeProvider, TITLES, ORDER };
