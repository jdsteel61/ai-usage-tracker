'use strict';

/**
 * Durable file replace: a random temporary name opened exclusively ('wx', so a
 * pre-planted file or symlink is never followed), written through its
 * descriptor, fsynced, then renamed over the target. Throws on any failure.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function writeFileAtomic(filePath, data, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = fsImpl.openSync(temporaryPath, 'wx');
    created = true;
    fsImpl.writeFileSync(descriptor, data, 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporaryPath, filePath);
    created = false;
  } finally {
    if (descriptor !== undefined) { try { fsImpl.closeSync(descriptor); } catch { /* already closed */ } }
    if (created) {
      try { fsImpl.unlinkSync(temporaryPath); } catch { /* cleanup unavailable */ }
    }
  }
}

module.exports = { writeFileAtomic };
