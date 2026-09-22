'use strict';

/**
 * Windows Credential Manager access, shelling out to the bundled PowerShell
 * bridge (credmgr.ps1). Secrets move only through the child's stdin/stdout
 * (Base64); they never appear on command lines, in argv listings, or logs.
 *
 * `runner` is injectable for tests (so tests never touch the real store).
 */
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'credmgr.ps1');
const TARGET = 'ai-usage-tracker:zai-api-key';

function runPs(args, stdinBase64, runner) {
  return new Promise((resolve, reject) => {
    const child = runner(args, stdinBase64);
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const stdout = out.trim();
      if (code === 0 && !stdout.startsWith('ERROR:')) resolve(stdout);
      else reject(new Error(stdout.startsWith('ERROR:') ? stdout : (err.trim() || `powershell exited ${code}`)));
    });
  });
}

function defaultRunner(args, stdinBase64) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, ...args,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  if (stdinBase64) child.stdin.end(stdinBase64);
  else child.stdin.end();
  return child;
}

/** Store a secret (utf8 string). */
async function writeSecret(secret, { target = TARGET, runner = defaultRunner } = {}) {
  const b64 = Buffer.from(String(secret), 'utf8').toString('base64');
  const out = await runPs(['-Action', 'write', '-Target', target], b64, runner);
  if (out !== 'OK') throw new Error(`credential write failed: ${out}`);
  return true;
}

/** Read a secret; null when absent. The result must never be logged. */
async function readSecret({ target = TARGET, runner = defaultRunner } = {}) {
  const out = await runPs(['-Action', 'read', '-Target', target], null, runner);
  if (out === 'NOT_FOUND') return null;
  return Buffer.from(out, 'base64').toString('utf8');
}

/** Presence check that never returns the secret. */
async function secretExists({ target = TARGET, runner = defaultRunner } = {}) {
  const out = await runPs(['-Action', 'exists', '-Target', target], null, runner);
  return out === 'PRESENT';
}

/** Remove the stored secret; succeeds when absent. */
async function deleteSecret({ target = TARGET, runner = defaultRunner } = {}) {
  const out = await runPs(['-Action', 'delete', '-Target', target], null, runner);
  if (out !== 'OK') throw new Error(`credential delete failed: ${out}`);
  return true;
}

module.exports = { writeSecret, readSecret, secretExists, deleteSecret, TARGET };
