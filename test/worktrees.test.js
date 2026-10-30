const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const wt = require('../lib/worktrees');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-wt-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('validName: accepts plain names, rejects shell and ref tricks', () => {
  for (const ok of ['feat-login', 'a', 'v1.2_x', 'A9']) assert.strictEqual(wt.validName(ok), true, ok);
  for (const bad of ['', '-x', '.x', 'a b', 'a/b', '../x', 'a..b', 'x.lock', 'x.', '$(id)', 'a;b', 'x'.repeat(41), null, undefined, 5]) assert.strictEqual(wt.validName(bad), false, String(bad));
});

test('create: worktree under .claude/worktrees with a worktree-<name> branch, reused on a second call', async t => {
  const dir = repo(t);
  const r = await wt.create(dir, 'feat-x');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.path, path.join(dir, '.claude', 'worktrees', 'feat-x'));
  assert.strictEqual(r.branch, 'worktree-feat-x');
  assert.strictEqual(git(r.path, 'branch', '--show-current').trim(), 'worktree-feat-x');
  const again = await wt.create(dir, 'feat-x');
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.existed, true);
  const l = await wt.list(dir, []);
  assert.deepStrictEqual(l.worktrees.map(w => w.name), ['feat-x']);
});

test('create: bad names and non-repos are refused, an existing branch is reused', async t => {
  const dir = repo(t);
  assert.ok((await wt.create(dir, '../evil')).error);
  assert.ok((await wt.create(dir, 'a b')).error);
  assert.ok((await wt.create(os.tmpdir(), 'ok')).error);
  git(dir, 'branch', 'worktree-old');
  const r = await wt.create(dir, 'old');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(git(r.path, 'branch', '--show-current').trim(), 'worktree-old');
});
