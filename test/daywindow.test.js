const test = require('node:test');
const assert = require('node:assert');

test('dayWindow keys and bounds follow the local day, west of UTC too', () => {
  process.env.TZ = 'America/Los_Angeles';
  const { dayWindow } = require('../lib/recap');
  const today = dayWindow(0), y = dayWindow(1);
  const start = new Date(today.start);
  assert.strictEqual(start.getHours(), 0);
  assert.strictEqual(today.key, `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`);
  assert.ok(Date.now() >= today.start && Date.now() < today.end);
  assert.strictEqual(y.end, today.start);
  assert.notStrictEqual(y.key, today.key);
});

test('a DST day is 25 hours, not 24', () => {
  process.env.TZ = 'America/Los_Angeles';
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.UTC(2026, 10, 2, 12)])); } static now() { return RealDate.UTC(2026, 10, 2, 12); } };
  try {
    delete require.cache[require.resolve('../lib/recap')];
    const { dayWindow } = require('../lib/recap');
    const fallBack = dayWindow(1);
    assert.strictEqual(fallBack.key, '2026-11-01');
    assert.strictEqual(fallBack.end - fallBack.start, 25 * 3600e3);
    assert.strictEqual(fallBack.end, dayWindow(0).start);
  } finally { global.Date = RealDate; }
});
