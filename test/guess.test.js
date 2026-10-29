const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { guess } = require('../lib/guess');

const DEV = '/home/u/dev';
const P = (rel, extra = {}) => { const segs = rel.split('/'); return { id: segs.join('--'), name: segs[segs.length - 1], dirName: segs[segs.length - 1], org: segs[0], rel, path: path.join(DEV, rel), ...extra }; };
const projects = [
  P('acme/teamhub'),
  P('acme/teamhub/teamhub-backend'),
  P('acme/teamhub/teamhub-web-app'),
  P('acme/ballpark/ballpark-backend'),
  P('acme/ballpark/ballpark-mobile-apps', { pkgName: 'ballpark' }),
  P('acme/ballpark/ballpark-admin-panel'),
  P('northwind/nw-api'),
  P('northwind/nw-backend'),
  P('northwind/nw-backend/services/api', { pkgName: '@nw-backend/api' }),
  P('contoso/helium', { pkgName: 'contoso-mobile-advisor' }),
  P('contoso/wealth-client'),
  P('contoso/wealth-mobile'),
  P('personal/zelena-basta/zelena-basta'),
  P('personal/zelena-basta/zelena-basta-ios'),
  P('personal/secret', { hidden: true }),
];
const g = (text, opts = {}) => guess(text, { projects, devRoot: DEV, home: '/home/u', ...opts });
const top = r => r.best.kind === 'project' ? r.best.id : `${r.best.kind}:${r.best.group || r.best.org || r.best.name}`;

test('an explicit project name wins and is confident, also with Bosnian case endings', () => {
  for (const [text, id] of [
    ['u teamhub backendu treba dodat endpoint', 'acme--teamhub--teamhub-backend'],
    ['teamhub', 'acme--teamhub'],
    ['ballpark admin panel ne radi login', 'acme--ballpark--ballpark-admin-panel'],
    ['nw api pada na deployu', 'northwind--nw-api'],
    ['zelena bašta ios build', 'personal--zelena-basta--zelena-basta-ios'],
    ['contoso mobile advisor crash', 'contoso--helium'],
  ]) {
    const r = g(text);
    assert.strictEqual(top(r), id, text);
    assert.strictEqual(r.confident, true, text);
    assert.strictEqual(r.best.cwd, path.join(DEV, projects.find(p => p.id === id).rel));
  }
});

test('a path in the text picks the deepest project that contains it', () => {
  const r = g('pogledaj ~/dev/northwind/nw-backend/services/api/src/x.ts');
  assert.strictEqual(r.best.id, 'northwind--nw-backend--services--api'); assert.strictEqual(r.confident, true);
  assert.strictEqual(g('/home/u/dev/acme/teamhub/teamhub-web-app/src/a.tsx line 3').best.id, 'acme--teamhub--teamhub-web-app');
});

test('a folder or org without a clear project is a folder candidate, not confident', () => {
  const r = g('ballpark');
  assert.deepStrictEqual([r.best.kind, r.best.org, r.best.group, r.best.cwd], ['org', 'acme', 'ballpark', path.join(DEV, 'acme/ballpark')]);
  assert.strictEqual(r.confident, false);
  const o = g('nesto za northwind');
  assert.deepStrictEqual([o.best.kind, o.best.org, o.best.cwd], ['org', 'northwind', path.join(DEV, 'northwind')]);
});

test('ambiguity is not confident; nothing recognisable falls back to the dev root', () => {
  const r = g('wealth');
  assert.strictEqual(r.confident, false);
  assert.ok(r.cands.some(c => c.id === 'contoso--wealth-client') && r.cands.some(c => c.id === 'contoso--wealth-mobile'));
  const n = g('napravi mi novu skriptu za backup');
  assert.strictEqual(n.best.kind, 'root'); assert.strictEqual(n.best.cwd, DEV); assert.strictEqual(n.confident, false);
  assert.strictEqual(g('').best.kind, 'root');
});

test('generic words alone never pick a project; hidden projects are ignored', () => {
  for (const t of ['api', 'fix the backend', 'mobile app web', 'infra']) assert.strictEqual(g(t).best.kind, 'root', t);
  assert.strictEqual(g('secret project').best.kind, 'root');
});

test('history and the open session only tip the balance; account hint comes from history', () => {
  const now = Date.now();
  const history = [
    { account: 'company', lastAt: now - 864e5, projects: ['contoso--helium'] },
    { account: 'company', lastAt: now - 2 * 864e5, projects: ['contoso--helium'] },
    { account: 'personal', lastAt: now - 3 * 864e5, projects: ['contoso--helium'] },
    { account: 'personal', lastAt: now - 864e5, projects: ['acme--teamhub--teamhub-web-app'] },
  ];
  const r = g('helium', { history, now });
  assert.strictEqual(r.best.id, 'contoso--helium'); assert.strictEqual(r.best.account, 'company');
  assert.match(r.best.why, /recent/);
  assert.strictEqual(g('napravi skriptu', { history, now }).best.kind, 'root');
  const c = g('dodaj test', { context: 'acme--teamhub--teamhub-web-app' });
  assert.strictEqual(c.best.id, 'acme--teamhub--teamhub-web-app'); assert.strictEqual(c.confident, false);
  assert.strictEqual(g('teamhub', { history, now }).best.account, undefined);
});

test('result shape: at most 6 candidates, root last, rounded scores, no internal fields', () => {
  const r = g('acme teamhub ballpark nw api zelena basta');
  assert.ok(r.cands.length <= 6);
  assert.strictEqual(r.cands[r.cands.length - 1].kind, 'root');
  for (const c of r.cands) { assert.ok(!('explicit' in c) && !('named' in c)); assert.strictEqual(c.score, Math.round(c.score * 10) / 10); assert.ok(c.cwd.startsWith(DEV)); }
});
