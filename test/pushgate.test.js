const test = require('node:test');
const assert = require('node:assert');
const { createPushGate } = require('../lib/pushgate');

test('a quick done that did not push does not block a permission right after', () => {
  const g = createPushGate();
  assert.strictEqual(g.blocked('claude-x', 'permission', 10000), false);
});

test('a done that pushed does not hold back a permission or an error', () => {
  const g = createPushGate();
  g.sent('claude-x', 'done', 0);
  assert.strictEqual(g.blocked('claude-x', 'permission', 1000), false);
  assert.strictEqual(g.blocked('claude-x', 'error', 1000), false);
  assert.strictEqual(g.blocked('claude-x', 'done', 1000), true);
  assert.strictEqual(g.blocked('claude-x', 'done', 31000), false);
});

test('sessions are throttled separately; repeated permissions only dedupe briefly', () => {
  const g = createPushGate();
  g.sent('claude-a', 'permission', 0);
  assert.strictEqual(g.blocked('claude-b', 'permission', 100), false);
  assert.strictEqual(g.blocked('claude-a', 'permission', 2000), true);
  assert.strictEqual(g.blocked('claude-a', 'permission', 6000), false);
});
