'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeFitScale } = require('../src/renderer/scale');

test('scale: picks the limiting axis', () => {
  assert.equal(computeFitScale(600, 216, 300, 300), 0.72); // height-limited
  assert.equal(computeFitScale(250, 600, 300, 200), 0.8333333333333334); // width-limited
});

test('scale: grows past 1 only up to max', () => {
  assert.equal(computeFitScale(900, 600, 300, 200), 1.8); // max clamp
  assert.equal(computeFitScale(400, 280, 300, 200), 4 / 3); // width-limited growth
});

test('scale: never below min', () => {
  assert.equal(computeFitScale(300, 170, 300, 400), 0.5);
});

test('scale: exact fit stays 1', () => {
  assert.equal(computeFitScale(300, 216, 300, 216), 1);
});

test('scale: invalid inputs fall back to 1', () => {
  assert.equal(computeFitScale(0, 100, 10, 10), 1);
  assert.equal(computeFitScale(100, 100, 0, 10), 1);
  assert.equal(computeFitScale(NaN, 100, 10, 10), 1);
  assert.equal(computeFitScale(100, 100, 10, -5), 1);
});
