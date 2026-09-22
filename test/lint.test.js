'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ESLint } = require('eslint');

/**
 * Lint gate: src/ and test/ must pass the flat config. Kept as a test so
 * `npm test` covers static analysis without a separate CI step.
 */
test('eslint: src/ and test/ are clean', async () => {
  const eslint = new ESLint({ cwd: require('path').join(__dirname, '..') });
  const results = await eslint.lintFiles(['src/**/*.js', 'test/**/*.js']);
  const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${r.filePath}:${m.line}:${m.column} ${m.message}`));
  for (const e of errors) console.error(e);
  assert.equal(errors.length, 0, `${errors.length} lint error(s)`);
});
