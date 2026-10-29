const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ck = require('../lib/checkpoints');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const rd = f => fs.readFileSync(f, 'utf8');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-ckpt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init');
  ck.init({ file: path.join(dir, 'checkpoints.json') });
  return { dir, repo, sess: { tmux: 'claude-t', cwd: repo, touched: [], lastPrompt: 'change things' } };
}
const indexSig = repo => { const f = path.join(repo, '.git', 'index'); return fs.readFileSync(f).toString('hex') + ':' + fs.statSync(f).mtimeMs; };

test('a turn records added, modified and deleted files without touching the real index', async t => {
  const { repo, sess } = setup(t);
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n'); sh(repo, 'add', 'staged.txt');
  const status = sh(repo, 'status', '--porcelain'); const before = indexSig(repo);
  await ck.begin(sess);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  fs.unlinkSync(path.join(repo, 'b.txt'));
  fs.mkdirSync(path.join(repo, 'sub dir'));
  fs.writeFileSync(path.join(repo, 'sub dir', 'new [x].txt'), 'fresh\n');
  fs.writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');
  await ck.end('claude-t', sess);
  assert.strictEqual(indexSig(repo), before);
  assert.match(status, /^A  staged\.txt$/m); assert.match(sh(repo, 'status', '--porcelain'), /^A  staged\.txt$/m);
  const [e] = ck.items('claude-t');
  assert.strictEqual(e.kind, 'turn'); assert.strictEqual(e.n, 1); assert.strictEqual(e.prompt, 'change things'); assert.ok(e.endAt >= e.startAt);
  assert.strictEqual(e.repos.length, 1);
  const x = e.repos[0];
  assert.strictEqual(x.top, fs.realpathSync(repo));
  const by = Object.fromEntries(x.list.map(l => [l.f, l]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['a.txt', 'b.txt', 'sub dir/new [x].txt']);
  assert.strictEqual(by['a.txt'].s, 'M'); assert.strictEqual(by['b.txt'].s, 'D'); assert.strictEqual(by['sub dir/new [x].txt'].s, 'A');
  assert.strictEqual(by['a.txt'].a, 2); assert.strictEqual(by['a.txt'].d, 1);
  assert.strictEqual(x.files, 3); assert.strictEqual(x.add, 3); assert.strictEqual(x.del, 2);
  const d = await ck.diff('claude-t', e.id, x.top, 'a.txt');
  assert.match(d.text, /^\+\+\+ b\/a\.txt$/m); assert.match(d.text, /^\+TWO$/m); assert.doesNotMatch(d.text, /b\.txt/);
  assert.match((await ck.diff('claude-t', e.id, x.top)).text, /new \[x\]\.txt/);
  assert.ok((await ck.diff('claude-t', e.id, '/nope')).error);
});

test('undo restores only the turn\'s files, flags later edits, and can itself be undone', async t => {
  const { repo, sess } = setup(t);
  await ck.begin(sess);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed by claude\n');
  fs.unlinkSync(path.join(repo, 'b.txt'));
  fs.mkdirSync(path.join(repo, 'deep', 'er'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'deep', 'er', 'c.txt'), 'created\n');
  await ck.end('claude-t', sess);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed by claude\nand later by you\n');
  fs.writeFileSync(path.join(repo, 'mine.txt'), 'not part of the turn\n');
  const [e] = ck.items('claude-t');

  const dry = await ck.restore('claude-t', e.id, { dry: true });
  assert.ok(dry.ok && dry.dry);
  const acts = Object.fromEntries(dry.repos[0].files.map(f => [f.f, f]));
  assert.deepStrictEqual(Object.keys(acts).sort(), ['a.txt', 'b.txt', 'deep/er/c.txt']);
  assert.strictEqual(acts['a.txt'].act, 'restore'); assert.strictEqual(acts['a.txt'].later, true);
  assert.strictEqual(acts['b.txt'].act, 'restore'); assert.strictEqual(acts['b.txt'].later, false);
  assert.strictEqual(acts['deep/er/c.txt'].act, 'delete');
  assert.strictEqual(rd(path.join(repo, 'a.txt')), 'changed by claude\nand later by you\n');

  const idx = indexSig(repo);
  const r = await ck.restore('claude-t', e.id, {});
  assert.ok(r.ok, r.error); assert.ok(r.undo);
  assert.strictEqual(rd(path.join(repo, 'a.txt')), 'one\ntwo\n');
  assert.strictEqual(rd(path.join(repo, 'b.txt')), 'bee\n');
  assert.ok(!fs.existsSync(path.join(repo, 'deep')));
  assert.strictEqual(rd(path.join(repo, 'mine.txt')), 'not part of the turn\n');
  assert.strictEqual(indexSig(repo), idx);

  const u = ck.items('claude-t')[0];
  assert.strictEqual(u.kind, 'undo'); assert.strictEqual(u.of, e.id); assert.strictEqual(u.id, r.undo);
  const back = await ck.restore('claude-t', u.id, {});
  assert.ok(back.ok, back.error);
  assert.strictEqual(rd(path.join(repo, 'a.txt')), 'changed by claude\nand later by you\n');
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')));
  assert.strictEqual(rd(path.join(repo, 'deep', 'er', 'c.txt')), 'created\n');

  const again = await ck.restore('claude-t', e.id, { dry: true });
  assert.ok(again.repos[0].files.length > 0);
});

test('undo keeps a file that was there before the turn but too big to snapshot, and a path that is a folder now', async t => {
  const { repo, sess } = setup(t);
  const big = path.join(repo, 'big.bin');
  fs.writeFileSync(big, ''); fs.truncateSync(big, 21 * 2 ** 20);
  await ck.begin(sess);
  fs.writeFileSync(big, 'small now\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  await ck.end('claude-t', sess);
  const [e] = ck.items('claude-t');
  assert.ok(e.repos[0].list.some(l => l.f === 'big.bin' && l.s === 'A'));
  fs.unlinkSync(path.join(repo, 'a.txt')); fs.mkdirSync(path.join(repo, 'a.txt')); fs.writeFileSync(path.join(repo, 'a.txt', 'inner.txt'), 'mine\n');

  const dry = await ck.restore('claude-t', e.id, { dry: true });
  const acts = Object.fromEntries(dry.repos[0].files.map(f => [f.f, f]));
  assert.strictEqual(acts['big.bin'].act, 'keep'); assert.match(acts['big.bin'].why, /too big/);
  assert.strictEqual(acts['a.txt'].act, 'keep'); assert.match(acts['a.txt'].why, /folder/);
  assert.strictEqual(acts['new.txt'].act, 'delete');

  const r = await ck.restore('claude-t', e.id, {});
  assert.ok(r.ok, r.error);
  assert.strictEqual(rd(big), 'small now\n');
  assert.strictEqual(rd(path.join(repo, 'a.txt', 'inner.txt')), 'mine\n');
  assert.ok(!fs.existsSync(path.join(repo, 'new.txt')));
});

test('a turn that changes nothing leaves no entry; onChange opens and closes on the right transitions', async t => {
  const { repo, sess } = setup(t);
  await ck.begin(sess); await ck.end('claude-t', sess);
  assert.strictEqual(ck.items('claude-t').length, 0);

  ck.onChange('hook', { ...sess, state: 'working' }, { state: 'idle' });
  ck.onChange('hook', { ...sess, state: 'permission' }, { state: 'working' });
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bzz\n');
  ck.onChange('hook', { ...sess, state: 'working' }, { state: 'permission' });
  ck.onChange('hook', { ...sess, state: 'needs-you' }, { state: 'working' });
  await ck.end('claude-t', sess);
  const list = ck.items('claude-t');
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].repos[0].list.map(l => l.f), ['b.txt']);
  assert.ok(list[0].endAt);
});

test('a new turn while one is open closes the old one first; sweep closes turns of idle sessions', async t => {
  const { repo, sess } = setup(t);
  await ck.begin(sess);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'first\n');
  await ck.begin(sess);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'second\n');
  ck.sweep(() => 'idle');
  await ck.end('claude-t', sess);
  const list = ck.items('claude-t');
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map(e => e.repos[0].list.map(l => l.f).join()), ['b.txt', 'a.txt']);
  assert.ok(list.every(e => e.endAt));
});

test('repos touched only during a turn are remembered for the next one; non-git paths are skipped', async t => {
  const { dir, repo, sess } = setup(t);
  const other = path.join(dir, 'other'); fs.mkdirSync(other); sh(other, 'init', '-q'); fs.writeFileSync(path.join(other, 'o.txt'), 'o\n'); sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'o');
  const plain = path.join(dir, 'plain'); fs.mkdirSync(plain);
  const s = { ...sess, cwd: plain };
  await ck.begin(s);
  fs.writeFileSync(path.join(other, 'o.txt'), 'oo\n');
  await ck.end('claude-t', { ...s, touched: [{ path: path.join(other, 'o.txt'), tool: 'Edit', at: Date.now() }] });
  assert.strictEqual(ck.items('claude-t').length, 0);
  await ck.begin(s);
  fs.writeFileSync(path.join(other, 'o.txt'), 'ooo\n');
  await ck.end('claude-t', s);
  const [e] = ck.items('claude-t');
  assert.strictEqual(e.repos[0].top, fs.realpathSync(other));
  assert.deepStrictEqual(e.repos[0].list.map(l => l.f), ['o.txt']);
});

test('state survives a reload through the file', async t => {
  const { dir, repo, sess } = setup(t);
  await ck.begin(sess); fs.writeFileSync(path.join(repo, 'a.txt'), 'z\n'); await ck.end('claude-t', sess);
  ck.flush();
  ck.init({ file: path.join(dir, 'checkpoints.json') });
  assert.strictEqual(ck.items('claude-t').length, 1);
  assert.strictEqual(ck.items('claude-t')[0].repos[0].list[0].f, 'a.txt');
});
