'use strict';

const test = require('node:test');
const assert = require('node:assert');
const credentials = require('../src/main/credentials');

/**
 * These tests use a fake runner so the REAL Windows Credential Manager is
 * never touched by the test suite (storing/removing real credentials is a
 * protected action reserved for the running app with user confirmation).
 */
function fakeRunner(reply) {
  const calls = [];
  const runner = (args, stdinBase64) => {
    calls.push({ args, stdinBase64 });
    return {
      stdout: { on: (_e, cb) => { setImmediate(() => cb(Buffer.from(reply.stdout || ''))); } },
      stderr: { on: (_e, cb) => { setImmediate(() => cb(Buffer.from(reply.stderr || ''))); } },
      on: (evt, cb) => { if (evt === 'error') setImmediate(() => {}); if (evt === 'exit') setImmediate(() => cb(reply.code)); },
      stdin: { end: () => {} },
    };
  };
  runner.calls = calls;
  return runner;
}

test('credentials: write passes the secret via stdin only, never argv', async () => {
  const runner = fakeRunner({ stdout: 'OK', code: 0 });
  await credentials.writeSecret('my-zai-key-123', { runner });
  assert.equal(runner.calls.length, 1);
  const { args, stdinBase64 } = runner.calls[0];
  assert.ok(!JSON.stringify(args).includes('my-zai-key-123'), 'secret never in argv');
  assert.equal(Buffer.from(stdinBase64, 'base64').toString('utf8'), 'my-zai-key-123');
  assert.deepEqual(args, ['-Action', 'write', '-Target', credentials.TARGET]);
});

test('credentials: read decodes base64 from stdout', async () => {
  const runner = fakeRunner({ stdout: Buffer.from('secret-value').toString('base64'), code: 0 });
  const secret = await credentials.readSecret({ runner });
  assert.equal(secret, 'secret-value');
});

test('credentials: read returns null for NOT_FOUND', async () => {
  const runner = fakeRunner({ stdout: 'NOT_FOUND', code: 0 });
  assert.equal(await credentials.readSecret({ runner }), null);
});

test('credentials: exists maps PRESENT/ABSENT', async () => {
  assert.equal(await credentials.secretExists({ runner: fakeRunner({ stdout: 'PRESENT', code: 0 }) }), true);
  assert.equal(await credentials.secretExists({ runner: fakeRunner({ stdout: 'ABSENT', code: 0 }) }), false);
});

test('credentials: powershell errors surface as rejections', async () => {
  const runner = fakeRunner({ stdout: 'ERROR: CredWriteW failed: 5', code: 1 });
  await assert.rejects(() => credentials.writeSecret('k', { runner }), /CredWriteW/);
});

test('credentials: delete succeeds on OK', async () => {
  const runner = fakeRunner({ stdout: 'OK', code: 0 });
  assert.equal(await credentials.deleteSecret({ runner }), true);
  assert.deepEqual(runner.calls[0].args, ['-Action', 'delete', '-Target', credentials.TARGET]);
});

// Startup-toggle logic: the persisted flag round-trips through the settings
// store and the tray/IPC layers merely reflect it (see history-settings tests
// for the store part; Electron's setLoginItemSettings is exercised in the
// running app because it needs a real registry).
test('startup toggle: default is off and only user action enables it', () => {
  const { sanitize } = require('../src/main/settings');
  assert.equal(sanitize({}).launchAtLogin, false);
  assert.equal(sanitize({ launchAtLogin: true }).launchAtLogin, true);
  assert.equal(sanitize({ launchAtLogin: 'yes' }).launchAtLogin, false);
});
