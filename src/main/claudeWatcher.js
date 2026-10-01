'use strict';

const fs = require('fs');

/** Watch the captured usage path, including files created or replaced later.
 * The caller refreshes local Claude data only; this watcher never polls providers. */
function watchClaudeUsage(filePath, onChange, {
  intervalMs = 1000,
  debounceMs = 100,
  watchFile = fs.watchFile,
  unwatchFile = fs.unwatchFile,
} = {}) {
  let stopped = false;
  let pending = null;
  const listener = (current, previous) => {
    if (stopped) return;
    // watchFile reports an initial ENOENT with two empty stats. Ignore it.
    const fields = ['mtimeMs', 'ctimeMs', 'size', 'ino', 'nlink'];
    if (fields.every((field) => current[field] === previous[field])) return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (!stopped) onChange();
    }, debounceMs);
    pending.unref();
  };
  watchFile(filePath, { persistent: false, interval: intervalMs }, listener);
  return () => {
    if (stopped) return;
    stopped = true;
    if (pending !== null) clearTimeout(pending);
    pending = null;
    unwatchFile(filePath, listener);
  };
}

module.exports = { watchClaudeUsage };
