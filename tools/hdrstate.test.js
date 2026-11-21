'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolve } = require('../src/hdrstate');

test('没有记录时以系统读数为准', () => {
  assert.deepStrictEqual(resolve(true, undefined), { enabled: true, clearHint: false });
  assert.deepStrictEqual(resolve(false, undefined), { enabled: false, clearHint: false });
});

test('关掉 HDR 后系统读数还是旧值（本次 bug）：以记录为准，且不能丢掉记录', () => {
  const r = resolve(true, false);
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.clearHint, false);
});

test('重新打开 HDR 后系统读数还停在关闭：以记录为准', () => {
  const r = resolve(false, true);
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.clearHint, false);
});

test('系统读数追上记录后，记录作废', () => {
  assert.deepStrictEqual(resolve(true, true), { enabled: true, clearHint: true });
  assert.deepStrictEqual(resolve(false, false), { enabled: false, clearHint: true });
});
