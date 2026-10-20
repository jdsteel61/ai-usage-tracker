'use strict';

// Identity metadata only. Saved Claude Code identities can be out of date;
// only a response authenticated with the profile's token is API-verified.
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function normalizeIdentity(account, organization, source) {
  if (!account || typeof account !== 'object') return null;
  const accountId = account.uuid || account.accountUuid;
  const organizationId = organization?.uuid || account.organizationUuid;
  const email = account.email || account.emailAddress;
  if (typeof accountId !== 'string' || !UUID.test(accountId)) return null;
  return {
    accountId: accountId.toLowerCase(),
    organizationId: typeof organizationId === 'string' && UUID.test(organizationId) ? organizationId.toLowerCase() : null,
    email: typeof email === 'string' && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+$/.test(email) ? email : null,
    source,
  };
}

function readSavedIdentity(configDir, { defaultProfile = false, readFileSync = fs.readFileSync, homeDir = os.homedir() } = {}) {
  // Claude's default state is beside ~/.claude; explicit profiles keep it inside
  // their config folder. Never fall back to the default account for a profile.
  const file = defaultProfile ? path.join(homeDir, '.claude.json') : path.join(configDir, '.claude.json');
  try {
    return normalizeIdentity(JSON.parse(readFileSync(file, 'utf8')).oauthAccount, null, 'saved');
  } catch { return null; }
}

module.exports = { normalizeIdentity, readSavedIdentity };
