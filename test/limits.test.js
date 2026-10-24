const test = require('node:test');
const assert = require('node:assert');
const { view } = require('../lib/limits');

test('a window whose reset has passed reads as reset at 0 %, not as the old number', () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const v = view({ session: { pct: 93, resetsAt: now - 3600e3, severity: 'critical' }, weekly: { pct: 40, resetsAt: now + 86400e3 }, scoped: [{ name: 'Fable', pct: 80, resetsAt: now - 1 }], fetchedAt: now - 60e3, error: null }, now);
  assert.deepStrictEqual([v.session.pct, v.session.resetsAt, v.session.reset, v.session.resetAt, v.session.severity], [0, null, true, now - 3600e3, null]);
  assert.strictEqual(v.weekly.pct, 40); assert.ok(!v.weekly.reset);
  assert.ok(v.scoped[0].reset);
  assert.strictEqual(v.stale, false);
});

test('stale when the last fetch failed or the data is older than two intervals', () => {
  const now = Date.UTC(2026, 9, 23, 12);
  assert.strictEqual(view({ fetchedAt: now - 60e3, error: 'token expired' }, now).stale, true);
  assert.strictEqual(view({ fetchedAt: now - 31 * 60e3, error: null }, now).stale, true);
  assert.strictEqual(view({ fetchedAt: now - 29 * 60e3, error: null }, now).stale, false);
});
