'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeIdentity, readSavedIdentity } = require('../src/main/claudeIdentity');
const { shapeSnapshot } = require('../src/main/snapshotView');
const { DEFAULTS } = require('../src/main/settings');

const accountId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const saved = { accountUuid: accountId, organizationUuid: organizationId, emailAddress: 'one@example.com' };

test('identity: default and explicit profiles read their own metadata, never fall back to another account', () => {
  const homeDir = path.resolve('fake-home');
  const configDir = path.join(homeDir, '.claude-work');
  const reads = [];
  const readFileSync = (file) => { reads.push(file); return JSON.stringify({ oauthAccount: saved, apiKey: 'must-not-escape' }); };
  assert.equal(readSavedIdentity(configDir, { homeDir, defaultProfile: true, readFileSync }).email, 'one@example.com');
  const result = readSavedIdentity(configDir, { homeDir, readFileSync });
  assert.deepEqual(reads, [path.join(homeDir, '.claude.json'), path.join(configDir, '.claude.json')]);
  assert.equal(result.source, 'saved');
  assert.ok(!JSON.stringify(result).includes('must-not-escape'));
  let calls = 0;
  assert.equal(readSavedIdentity(configDir, { readFileSync: () => { calls++; throw new Error('missing'); } }), null);
  assert.equal(calls, 1);
});

test('identity: malformed IDs and display fields cannot impersonate a verified account', () => {
  assert.equal(normalizeIdentity({ uuid: 'not-an-id', email: 'one@example.com' }, null, 'api'), null);
  assert.equal(normalizeIdentity({ uuid: accountId, email: 'one@example.com\nsecret' }, null, 'api').email, null);
  assert.deepEqual(normalizeIdentity({ uuid: accountId, email: 'one@example.com', accessToken: 'secret' },
    { uuid: organizationId }, 'api'), { accountId, organizationId, email: 'one@example.com', source: 'api' });
});

test('identity: duplicate account/subscription warnings distinguish saved metadata from API verification', () => {
  const profile = { id: 'claude-profile-work', label: 'Work', configDir: 'C:/work' };
  const settings = { ...DEFAULTS, claudeProfiles: [profile] };
  const identity = normalizeIdentity(saved, null, 'saved');
  const diagnostics = { claude: { identity }, [profile.id]: { identity: { ...identity, accountId: '33333333-3333-4333-8333-333333333333' } } };
  let view = shapeSnapshot({}, { settings, claudeDiagnostics: diagnostics });
  assert.match(view.providers.find((p) => p.id === 'claude').accountWarning, /Same saved.*unverified.*Work/);
  diagnostics.claude.identity = { ...identity, source: 'api' };
  diagnostics[profile.id].identity = { ...identity, source: 'api' };
  view = shapeSnapshot({}, { settings, claudeDiagnostics: diagnostics });
  assert.match(view.providers.find((p) => p.id === 'claude').accountWarning, /Same API.*Work/);
  diagnostics[profile.id].identity = { ...identity, source: 'api', accountId: '44444444-4444-4444-8444-444444444444', organizationId: null };
  diagnostics[profile.id].savedIdentity = identity;
  view = shapeSnapshot({}, { settings, claudeDiagnostics: diagnostics });
  assert.equal(view.providers.find((p) => p.id === 'claude').accountWarning, undefined);
  assert.match(view.providers.find((p) => p.id === profile.id).accountWarning, /Saved Claude identity differs/);
});

test('identity: persisted API auth blocks remain visible even when the usage cache contains no error', () => {
  const view = shapeSnapshot({ claude: { ok: true, windows: [], fetchedAt: 1000 } }, {
    settings: DEFAULTS, now: 2000, claudeDiagnostics: { claude: { apiError: { code: 'NO_AUTH', message: 'API login rejected' } } },
  });
  const claude = view.providers.find((p) => p.id === 'claude');
  assert.equal(claude.error.code, 'NO_AUTH');
  assert.equal(claude.stale, true);
});
