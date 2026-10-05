'use strict';

// Pass explicit files: `node --test test/` fails on Node 22, and shell globs
// are not expanded by cmd.exe on Windows.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.resolve(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort()
  .map((name) => path.join('test', name));
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit', cwd: path.resolve(__dirname, '..'),
});
process.exitCode = result.status === null ? 1 : result.status;
