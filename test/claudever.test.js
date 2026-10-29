const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cv = require('../lib/claudever');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

function setup(t, versions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cv-'));
  const vdir = path.join(root, 'versions'), state = path.join(root, 'state'), link = path.join(root, 'bin', 'claude');
  fs.mkdirSync(vdir); fs.mkdirSync(state); fs.mkdirSync(path.dirname(link));
  for (const [v, broken] of Object.entries(versions)) {
    fs.writeFileSync(path.join(vdir, v), `#!/bin/sh\n${broken ? 'FAKE_BROKEN=1 ' : ''}FAKE_VERSION=${v} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  }
  const point = v => { try { fs.unlinkSync(link); } catch {} fs.symlinkSync(path.join(vdir, v), link); };
  const events = [];
  const start = () => cv.init({ stateDir: state, versionsDir: vdir, link, poll: false, retryMs: 10, onChange: (s, prev) => events.push({ using: s.using, prev }) });
  t.after(() => { cv.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, vdir, state, link, point, start, events, saved: () => JSON.parse(fs.readFileSync(path.join(state, 'claude-version.json'), 'utf8')) };
}

const settle = async () => { for (let i = 0; i < 200 && cv.status().checking; i++) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 20)); };

test('check: handshake passes on a working build and fails on a broken one', async t => {
  const e = setup(t, { '1.0.0': false, '1.0.1': true });
  const ok = await cv.check(path.join(e.vdir, '1.0.0'));
  assert.strictEqual(ok.ok, true);
  const bad = await cv.check(path.join(e.vdir, '1.0.1'));
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /exited 1.*broken build/);
  const missing = await cv.check(path.join(e.vdir, 'nope'));
  assert.strictEqual(missing.ok, false);
});

test('a new good version becomes current, lkg and gets a kept copy', async t => {
  const e = setup(t, { '1.0.0': false });
  e.point('1.0.0'); e.start(); cv.refresh(); await settle();
  const s = cv.status();
  assert.strictEqual(s.current, '1.0.0'); assert.strictEqual(s.using, '1.0.0'); assert.strictEqual(s.fallback, false); assert.strictEqual(s.error, null);
  assert.strictEqual(s.bin, path.join(e.vdir, '1.0.0'));
  assert.strictEqual(e.saved().lkg, '1.0.0');
  assert.ok(fs.existsSync(path.join(e.state, 'claude-lkg', '1.0.0')));
});

test('a broken update falls back to the last good version, even after the updater deleted it', async t => {
  const e = setup(t, { '1.0.0': false, '1.1.0': true });
  e.point('1.0.0'); e.start(); cv.refresh(); await settle();
  e.point('1.1.0'); cv.refresh(); await settle();
  let s = cv.status();
  assert.strictEqual(s.current, '1.1.0'); assert.strictEqual(s.using, '1.0.0'); assert.strictEqual(s.fallback, true); assert.match(s.error, /broken build/);
  fs.unlinkSync(path.join(e.vdir, '1.0.0'));
  s = cv.status();
  assert.strictEqual(s.using, '1.0.0'); assert.strictEqual(s.bin, path.join(e.state, 'claude-lkg', '1.0.0'));
  assert.ok(e.events.some(x => x.using === '1.0.0'));
});

test('known versions are not checked again; recheck runs it again', async t => {
  const e = setup(t, { '1.0.0': false });
  e.point('1.0.0'); e.start(); cv.refresh(); await settle();
  const at = e.saved().good['1.0.0'];
  cv.refresh(); await settle();
  assert.strictEqual(e.saved().good['1.0.0'], at);
  e.start(); cv.refresh(); assert.strictEqual(cv.status().checking, false);
  await new Promise(r => setTimeout(r, 5));
  await cv.recheck();
  assert.ok(e.saved().good['1.0.0'] > at);
});

test('pin wins over current; unknown pins are refused; unpin goes back', async t => {
  const e = setup(t, { '1.0.0': false, '1.1.0': false });
  e.point('1.0.0'); e.start(); cv.refresh(); await settle();
  e.point('1.1.0'); cv.refresh(); await settle();
  assert.strictEqual(cv.status().using, '1.1.0');
  assert.strictEqual(cv.pin('9.9.9').ok, false);
  assert.strictEqual(cv.pin('1.0.0').ok, true);
  assert.strictEqual(cv.status().using, '1.0.0'); assert.strictEqual(cv.status().fallback, true);
  cv.pin(null);
  assert.strictEqual(cv.status().using, '1.1.0');
});

test('kept copies: newest two good versions only', async t => {
  const e = setup(t, { '1.0.0': false, '1.0.1': false, '1.0.2': false });
  e.start();
  for (const v of ['1.0.0', '1.0.1', '1.0.2']) { e.point(v); cv.refresh(); await settle(); }
  assert.deepStrictEqual(fs.readdirSync(path.join(e.state, 'claude-lkg')).sort(), ['1.0.1', '1.0.2']);
});

test('claude outside the versions dir is unmanaged: plain "claude"', async t => {
  const e = setup(t, { '1.0.0': false });
  fs.writeFileSync(e.link, '#!/bin/sh\n', { mode: 0o755 });
  e.start(); cv.refresh();
  const s = cv.status();
  assert.strictEqual(s.current, null); assert.strictEqual(s.using, null); assert.strictEqual(s.bin, 'claude'); assert.strictEqual(s.checking, false);
});

test('fake mode returns the fake binary and never polls', t => {
  cv.init({ stateDir: os.tmpdir(), fake: '/x/fake', poll: false });
  t.after(() => cv.stop());
  assert.strictEqual(cv.bin(), '/x/fake');
  assert.strictEqual(cv.status().bin, '/x/fake');
  assert.strictEqual(cv.pin('1.0.0').ok, false);
});

test('chatBin is plain claude unless a fallback or pin is active', async t => {
  const e = setup(t, { '1.0.0': false, '1.1.0': true });
  e.point('1.0.0'); e.start(); cv.refresh(); await settle();
  assert.strictEqual(cv.chatBin(), 'claude');
  e.point('1.1.0'); cv.refresh(); await settle();
  assert.strictEqual(cv.chatBin(), path.join(e.vdir, '1.0.0'));
});

test('a failed recheck of the last good version moves lkg to the next good one', async t => {
  const e = setup(t, { '1.0.0': false, '1.1.0': false });
  e.start();
  for (const v of ['1.0.0', '1.1.0']) { e.point(v); cv.refresh(); await settle(); }
  assert.strictEqual(e.saved().lkg, '1.1.0');
  fs.writeFileSync(path.join(e.vdir, '1.1.0'), `#!/bin/sh\nFAKE_BROKEN=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  fs.rmSync(path.join(e.state, 'claude-lkg', '1.1.0'));
  await cv.recheck();
  assert.strictEqual(e.saved().lkg, '1.0.0');
  assert.strictEqual(cv.status().using, '1.0.0'); assert.strictEqual(cv.status().fallback, true);
});
