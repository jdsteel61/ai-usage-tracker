'use strict';

/**
 * Where a Claude profile's saved login lives, resolved defensively. API top-up
 * approval is bound to the canonical location returned by
 * canonicalCredentialPath, so a profile whose folder is repointed (junction,
 * symlink, changed path) no longer matches what the user approved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS_FILE = '.credentials.json';

function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
}

/** Real (symlink-free) path of <configDir>/.credentials.json, or null when the
 * folder is missing, relative, or written with ".." segments. The file itself
 * need not exist. */
function canonicalCredentialPath(configDir, fsImpl = fs) {
  const dir = configDir || path.join(os.homedir(), '.claude');
  if (typeof dir !== 'string' || dir.includes('\0') || !path.isAbsolute(dir)
      || dir.split(/[\\/]+/).includes('..')) return null;
  try { return path.join(fsImpl.realpathSync(dir), CREDENTIALS_FILE); } catch { return null; }
}

/** The credential file to read: { ok: true, file, mtimeMs } or { ok: false }.
 * Rejects symlinks/reparse points and any file whose real path is not the
 * canonical location inside the profile folder. */
function resolveCredentialFile(configDir, fsImpl = fs) {
  const expected = canonicalCredentialPath(configDir, fsImpl);
  if (!expected) return { ok: false };
  try {
    const stat = fsImpl.lstatSync(expected);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false };
    if (!samePath(fsImpl.realpathSync(expected), expected)) return { ok: false };
    return { ok: true, file: expected, mtimeMs: stat.mtimeMs };
  } catch { return { ok: false }; }
}

module.exports = { canonicalCredentialPath, resolveCredentialFile, samePath, CREDENTIALS_FILE };
