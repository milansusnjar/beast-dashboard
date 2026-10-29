const test = require('node:test');
const assert = require('node:assert');
const settle = require('../lib/settle');

function mem() { let v = {}; return { get: () => v, update: p => { v = { ...v, ...p }; return v; } }; }

test('settle stays until the session needs you again; unsettle removes it', () => {
  const st = mem(); settle.init({ store: st });
  assert.ok(settle.set('claude-a', null, 1000).ok);
  assert.deepStrictEqual(settle.of('claude-a', 2000), { at: 1000, until: null });
  assert.strictEqual(settle.onChange('hook', { tmux: 'claude-a', state: 'working' }), false);
  assert.ok(settle.quiet('claude-a'));
  assert.strictEqual(settle.onChange('hook', { tmux: 'claude-a', state: 'needs-you' }), true);
  assert.strictEqual(settle.of('claude-a'), null);
  settle.set('claude-a', null); settle.set('claude-a', false);
  assert.strictEqual(settle.of('claude-a'), null);
  assert.deepStrictEqual(st.get().settled, {});
});

test('snooze ignores a finished turn but wakes on permission, and expires', () => {
  const st = mem(); settle.init({ store: st });
  const now = Date.now();
  assert.ok(settle.set('claude-b', now + 3600e3, now).ok);
  assert.strictEqual(settle.onChange('hook', { tmux: 'claude-b', state: 'needs-you' }), false);
  assert.ok(settle.of('claude-b', now + 10));
  assert.strictEqual(settle.of('claude-b', now + 3600e3), null);
  assert.strictEqual(settle.onChange('hook', { tmux: 'claude-b', state: 'permission' }), true);
  settle.set('claude-b', now + 1000, now); settle.set('claude-c', null, now);
  assert.strictEqual(settle.expire(now + 2000), true);
  assert.deepStrictEqual(Object.keys(st.get().settled), ['claude-c']);
  assert.strictEqual(settle.expire(now + 3000, new Set(['claude-x'])), true);
  assert.deepStrictEqual(st.get().settled, {});
});

test('bad input is refused', () => {
  settle.init({ store: mem() });
  assert.strictEqual(settle.set('../x', null).ok, false);
  assert.strictEqual(settle.set('claude-a', Date.now() - 1).ok, false);
  assert.strictEqual(settle.set('claude-a', Date.now() + 30 * 86400e3).ok, false);
  assert.strictEqual(settle.set('claude-a', 'soon').ok, false);
});

test('a question or permission that comes after settling wakes it; a state from before does not', () => {
  const st = mem(); settle.init({ store: st });
  const now = Date.now();
  settle.set('claude-d', now + 3600e3, now);
  assert.strictEqual(settle.wake('claude-d', 'permission', now - 5000), false);
  assert.ok(settle.of('claude-d', now + 1));
  assert.strictEqual(settle.wake('claude-d', 'needs-you', now + 1000), false);
  assert.strictEqual(settle.wake('claude-d', 'permission', now + 1000), true);
  assert.strictEqual(settle.of('claude-d', now + 2000), null);
  settle.set('claude-e', null, now);
  assert.strictEqual(settle.wake('claude-e', 'needs-you', now - 1), false);
  assert.strictEqual(settle.wake('claude-e', 'needs-you', now + 1), true);
});
