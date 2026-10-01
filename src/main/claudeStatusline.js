'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function usagePath(configDir = path.join(os.homedir(), '.claude')) {
  return path.join(configDir, 'ai-usage-tracker', 'usage.json');
}

/** Persist only subscription usage fields, never the full status-line input. */
function captureUsage(input, configDir, now = Date.now()) {
  const filePath = usagePath(configDir);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* first reading */ }
  const windows = {};
  let changed = false;
  for (const key of ['five_hour', 'seven_day']) {
    const old = previous.windows && previous.windows[key];
    if (old && Number.isFinite(old.usedPercent) && Number.isFinite(old.observedAt)
        && Date.parse(old.resetsAt) > now) windows[key] = {
      usedPercent: old.usedPercent, resetsAt: old.resetsAt, observedAt: old.observedAt,
    };
    const current = input && input.rate_limits && input.rate_limits[key];
    if (!current || !Number.isFinite(current.used_percentage)
        || current.used_percentage < 0 || current.used_percentage > 100
        || !Number.isFinite(current.resets_at) || current.resets_at * 1000 <= now
        || current.resets_at * 1000 > 8.64e15) continue;
    windows[key] = { usedPercent: current.used_percentage,
      resetsAt: new Date(current.resets_at * 1000).toISOString(), observedAt: now };
    changed = true;
  }
  if (!changed) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, windows }), 'utf8');
  fs.renameSync(temp, filePath);
  return true;
}

function statuslineShell() {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/sh';
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'Git', 'bin', 'bash.exe')];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || 'powershell.exe';
}

/** Wrap the existing command, preserving its output and other Claude settings. */
function installCapture(configDir) {
  const settingsPath = path.join(configDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (cause) { if (cause.code !== 'ENOENT') throw new Error('Claude settings must contain valid JSON'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Claude settings');
  if (settings.disableAllHooks === true) throw new Error('Claude status lines are disabled by disableAllHooks');
  const dir = path.dirname(usagePath(configDir));
  const runnerPath = path.join(dir, 'collector.cjs');
  const command = `node "${runnerPath.replace(/\\/g, '/')}" "${configDir.replace(/\\/g, '/')}"`;
  fs.mkdirSync(dir, { recursive: true });
  if (!settings.statusLine || settings.statusLine.command !== command) {
    if (settings.statusLine && settings.statusLine.type !== 'command') throw new Error('Unsupported Claude status-line type');
    fs.writeFileSync(path.join(dir, 'original-statusline.json'), JSON.stringify(settings.statusLine || null, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'forward.json'), JSON.stringify({
      command: settings.statusLine && settings.statusLine.command || null, shell: statuslineShell(),
    }), 'utf8');
  }
  fs.copyFileSync(path.join(__dirname, 'claudeStatusline.js'), path.join(dir, 'claudeStatusline.js'));
  fs.copyFileSync(path.join(__dirname, 'claude-statusline.cjs'), runnerPath);
  settings.statusLine = { ...(settings.statusLine || {}), type: 'command', command };
  const temp = `${settingsPath}.ai-usage-tracker.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(temp, settingsPath);
  return { ok: true };
}

module.exports = { captureUsage, usagePath, installCapture };
