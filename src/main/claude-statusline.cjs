'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { captureUsage } = require('./claudeStatusline');

const configDir = process.argv[2];
const input = fs.readFileSync(0, 'utf8');
let data = null;
try {
  data = JSON.parse(input);
  captureUsage(data, configDir);
} catch { /* capture must not disrupt the existing status line */ }

let forward = {};
try { forward = JSON.parse(fs.readFileSync(path.join(configDir, 'ai-usage-tracker', 'forward.json'), 'utf8')); }
catch { /* default display when no previous status line exists */ }
if (forward.command) {
  const args = /powershell(?:\.exe)?$/i.test(forward.shell)
    ? ['-NoProfile', '-Command', forward.command] : ['-c', forward.command];
  const result = spawnSync(forward.shell, args, {
    input, windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
} else {
  const parts = [];
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'Week']]) {
    const value = data && data.rate_limits && data.rate_limits[key];
    if (value && Number.isFinite(value.used_percentage)) parts.push(`${label}: ${Math.round(value.used_percentage)}%`);
  }
  process.stdout.write(parts.length ? parts.join(' | ') : 'Claude usage: waiting for a reading');
}
