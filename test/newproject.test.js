const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check, create } = require('../lib/newproject');

function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-newproj-'));
  const devRoot = path.join(base, 'dev');
  fs.mkdirSync(path.join(devRoot, 'acme', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(devRoot, 'acme', 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(devRoot, 'acme', 'taken'));
  fs.mkdirSync(path.join(base, 'outside'));
  fs.symlinkSync(path.join(base, 'outside'), path.join(devRoot, 'escape'));
  fs.symlinkSync(devRoot, path.join(devRoot, 'loop'));
  fs.writeFileSync(path.join(devRoot, 'afile'), '');
  return { base, devRoot, opts: { devRoot, scanDepth: 4 } };
}

test('accepts a project in an existing org, a group folder and a new org', () => {
  const { devRoot, opts } = tree();
  const a = check({ org: 'acme', name: 'my-app', account: 'company' }, opts);
  assert.equal(a.ok, true); assert.equal(a.target, path.join(devRoot, 'acme', 'my-app')); assert.equal(a.account, 'company'); assert.equal(a.newOrg, false);
  const g = check({ org: 'acme', group: 'tools', name: 'cli' }, opts);
  assert.equal(g.ok, true); assert.equal(g.rel, path.join('acme', 'tools', 'cli')); assert.equal(g.account, 'personal');
  const n = check({ org: 'neworg', name: 'x', account: 'weird' }, opts);
  assert.equal(n.ok, true); assert.equal(n.newOrg, true); assert.equal(n.account, 'personal');
});

test('rejects bad names, traversal and missing groups with 400', () => {
  const { opts } = tree();
  for (const b of [{}, { org: 'acme' }, { org: '..', name: 'x' }, { org: 'acme', name: '.hidden' }, { org: 'acme', name: 'a/b' }, { org: 'acme', name: '-x' },
    { org: 'acme', group: '../..', name: 'x' }, { org: 'acme', group: 'nope', name: 'x' }, { org: 'acme', name: 'x'.repeat(65) }, { org: 'acme', group: 5, name: 'x' },
    { org: 'acme', name: 'node_modules' }, { org: 'build', name: 'x' }]) {
    const r = check(b, opts); assert.equal(r.ok, false, JSON.stringify(b)); assert.equal(r.status, 400, JSON.stringify(b));
  }
});

test('rejects symlinks out of devRoot or back onto it, files, nesting in a project, too deep, existing', () => {
  const { opts } = tree();
  assert.equal(check({ org: 'escape', name: 'x' }, opts).status, 400);
  assert.equal(check({ org: 'loop', name: 'x' }, opts).status, 400);
  assert.equal(check({ org: 'afile', name: 'x' }, opts).status, 400);
  assert.match(check({ org: 'acme', group: 'repo', name: 'x' }, opts).error, /inside project acme\/repo/);
  assert.equal(check({ org: 'acme', group: 'tools', name: 'x' }, { ...opts, scanDepth: 2 }).status, 400);
  assert.equal(check({ org: 'acme', name: 'taken' }, opts).status, 409);
});

test('create makes the folder with git on main, new org included', async () => {
  const { devRoot, opts } = tree();
  const c = check({ org: 'neworg', name: 'app' }, opts);
  assert.deepEqual(await create(c, devRoot), { ok: true });
  assert.equal(fs.readFileSync(path.join(devRoot, 'neworg', 'app', '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main');
  assert.equal(check({ org: 'neworg', name: 'app' }, opts).status, 409);
  const again = await create(c, devRoot);
  assert.equal(again.ok, false); assert.equal(again.status, 409);
  assert.ok(fs.existsSync(path.join(devRoot, 'neworg', 'app', '.git')));
});
