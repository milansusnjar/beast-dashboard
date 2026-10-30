const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../lib/history');

const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (text, at, extra = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content: text }, timestamp: new Date(at).toISOString(), cwd: extra.cwd, ...extra });
const tool = (file, at) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] }, timestamp: new Date(at).toISOString() });
const result = at => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, timestamp: new Date(at).toISOString() });

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hist-'));
  const roots = { personal: path.join(root, 'p'), company: path.join(root, 'c') };
  const dev = path.join(root, 'dev');
  const projects = [
    { id: 'acme--shop', name: 'Shop', dirName: 'shop', org: 'acme', path: path.join(dev, 'acme', 'shop') },
    { id: 'acme--shop-api', name: 'Shop API', dirName: 'shop-api', org: 'acme', path: path.join(dev, 'acme', 'shop', 'api') },
    { id: 'beta--app', name: 'Beta App', dirName: 'app', org: 'beta', path: path.join(dev, 'beta', 'app') },
  ];
  const write = (account, slug, id, lines) => {
    const d = path.join(roots[account], slug); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, id + '.jsonl'); fs.writeFileSync(f, lines.join('\n') + '\n'); return f;
  };
  const live = {};
  const start = () => h.init({ roots, file: path.join(root, 'history.json'), labelsFile: path.join(root, 'labels.json'), projects: () => projects, live: id => live[id] || null, every: 60e3 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, roots, dev, projects, write, live, start };
}

test('index: titles, prompts, projects, account; meta, slash commands and tool results are not prompts', async t => {
  const e = setup(t);
  const shop = path.join(e.dev, 'acme', 'shop');
  e.write('personal', 'x', ID(1), [
    user('<command-name>/clear</command-name>', 1000, { cwd: shop }),
    user('caveat', 1500, { cwd: shop, isMeta: true }),
    user('fix the checkout bug', 2000, { cwd: shop }),
    tool(path.join(shop, 'api', 'src', 'a.ts'), 3000),
    result(3100),
    tool(path.join(shop, 'api', 'src', 'b.ts'), 3200),
    tool(path.join(e.dev, 'beta', 'app', 'x.ts'), 3300),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Checkout bug', sessionId: ID(1) }),
    user('now  add\n a test', 4000, { cwd: shop }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My checkout fix', sessionId: ID(1) }),
  ]);
  e.write('company', 'y', ID(2), [user('hello there', 5000, { cwd: path.join(e.dev, 'beta', 'app') })]);
  e.write('personal', 'z', ID(3), [JSON.stringify({ type: 'summary', summary: 'x' })]);
  e.start();
  const r = await h.query({});
  assert.strictEqual(r.total, 2);
  const [b, a] = r.items;
  assert.strictEqual(b.id, ID(2)); assert.strictEqual(b.account, 'company'); assert.strictEqual(b.project, 'beta--app');
  assert.strictEqual(a.id, ID(1)); assert.strictEqual(a.account, 'personal');
  assert.strictEqual(a.title, 'My checkout fix');
  assert.strictEqual(a.firstPrompt, 'fix the checkout bug');
  assert.strictEqual(a.lastPrompt, 'now add a test');
  assert.strictEqual(a.prompts, 4);
  assert.strictEqual(a.startedAt, 1000); assert.strictEqual(a.lastAt, 4000);
  assert.strictEqual(a.project, 'acme--shop');
  assert.deepStrictEqual(a.projects, ['acme--shop', 'acme--shop-api', 'beta--app']);
  assert.strictEqual(a.cwd, shop);
  assert.ok(a.file.endsWith(ID(1) + '.jsonl'));
  assert.strictEqual(a.label, null); assert.strictEqual(a.live, null);
});

test('incremental: a file is read again only when its size or mtime changed; deleted files drop out', async t => {
  const e = setup(t);
  const f = e.write('personal', 'x', ID(1), [user('first', 1000, { cwd: e.dev })]);
  const g = e.write('personal', 'x', ID(2), [user('second', 2000, { cwd: e.dev })]);
  fs.utimesSync(f, 1e6, 1e6);
  e.start();
  await h.refresh(true);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('first', 'FIRST'));
  fs.utimesSync(f, 1e6, 1e6);
  await h.refresh(true);
  assert.strictEqual((await h.query({ q: 'first' })).items[0].firstPrompt, 'first');
  fs.appendFileSync(f, user('more', 3000) + '\n');
  await h.refresh(true);
  const it = (await h.query({ q: 'first' })).items[0];
  assert.strictEqual(it.firstPrompt, 'FIRST'); assert.strictEqual(it.lastPrompt, 'more');
  fs.unlinkSync(g);
  await h.refresh(true);
  assert.strictEqual((await h.query({})).total, 1);
  e.start();
  assert.strictEqual((await h.query({})).items[0].lastPrompt, 'more');
});

test('query: all words, account, project, limit, labels and live sessions', async t => {
  const e = setup(t);
  e.write('personal', 'x', ID(1), [user('fix the checkout bug', 1000, { cwd: path.join(e.dev, 'acme', 'shop') })]);
  e.write('company', 'y', ID(2), [user('deploy the release', 2000, { cwd: path.join(e.dev, 'beta', 'app') })]);
  e.write('personal', 'x', ID(3), [user('checkout copy text', 3000, { cwd: e.dev })]);
  e.live[ID(3)] = 'claude-chat-261029-1000';
  e.start();
  assert.deepStrictEqual((await h.query({ q: 'checkout' })).items.map(i => i.id), [ID(3), ID(1)]);
  assert.deepStrictEqual((await h.query({ q: 'checkout bug' })).items.map(i => i.id), [ID(1)]);
  assert.deepStrictEqual((await h.query({ q: 'CHECKOUT shop' })).items.map(i => i.id), [ID(1)]);
  assert.deepStrictEqual((await h.query({ q: 'beta' })).items.map(i => i.id), [ID(2)]);
  assert.deepStrictEqual((await h.query({ account: 'company' })).items.map(i => i.id), [ID(2)]);
  assert.deepStrictEqual((await h.query({ project: 'acme--shop' })).items.map(i => i.id), [ID(1)]);
  const lim = await h.query({ limit: 1 });
  assert.strictEqual(lim.items.length, 1); assert.strictEqual(lim.total, 3);
  assert.strictEqual(lim.items[0].live, 'claude-chat-261029-1000');
  assert.strictEqual(h.setLabel('nope', 'x').ok, false);
  assert.deepStrictEqual(h.setLabel(ID(2), '  Release night  '), { ok: true, label: 'Release night' });
  assert.strictEqual(h.labelOf(ID(2)), 'Release night');
  assert.deepStrictEqual((await h.query({ q: 'night' })).items.map(i => i.id), [ID(2)]);
  h.setLabel(ID(2), '');
  assert.strictEqual(h.labelOf(ID(2)), null);
});

test('long lines and very large files: windows only, cwd and a prompt still found', async t => {
  const e = setup(t);
  const big = 'x'.repeat(600 * 1024);
  e.write('personal', 'x', ID(1), [
    user('start here', 1000),
    JSON.stringify({ type: 'system', cwd: e.dev, blob: big }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: big }] }, timestamp: new Date(2000).toISOString() }),
    user('the end', 3000, { cwd: e.dev }),
  ]);
  e.start();
  const [it] = (await h.query({})).items;
  assert.strictEqual(it.cwd, e.dev);
  assert.strictEqual(it.firstPrompt, 'start here'); assert.strictEqual(it.lastPrompt, 'the end'); assert.strictEqual(it.lastAt, 3000);
});

test('a first prompt beyond the head window falls back to the first prompt in the tail', async t => {
  const e = setup(t);
  e.write('personal', 'x', ID(1), [
    user('look at this screenshot ' + 'y'.repeat(300 * 1024), 1000, { cwd: e.dev }),
    user('and then this', 2000, { cwd: e.dev }),
  ]);
  e.start();
  const [it] = (await h.query({})).items;
  assert.strictEqual(it.cwd, e.dev);
  assert.match(it.firstPrompt, /^look at this screenshot y+…$/);
  assert.strictEqual(it.firstPrompt.length, 200);
  assert.strictEqual(it.lastPrompt, 'and then this');
});

test('broken state files: bad records are re-read, non-string labels dropped', async t => {
  const e = setup(t);
  const f = e.write('personal', 'x', ID(1), [user('hello there', 1000, { cwd: e.dev })]);
  const st = fs.statSync(f);
  fs.writeFileSync(path.join(e.root, 'history.json'), JSON.stringify({ v: 1, files: { [f]: { size: st.size, mtime: Math.trunc(st.mtimeMs) } } }));
  fs.writeFileSync(path.join(e.root, 'labels.json'), JSON.stringify({ [ID(1)]: 42, [ID(2)]: 'ok', [ID(3)]: { x: 1 } }));
  e.start();
  const [it] = (await h.query({})).items;
  assert.strictEqual(it.firstPrompt, 'hello there');
  assert.strictEqual(it.label, null);
  assert.strictEqual(h.labelOf(ID(2)), 'ok');
  assert.strictEqual(h.labelOf(ID(3)), null);
});

test('latestFor: newest conversation whose folder is exactly the given one, per account', async t => {
  const e = setup(t);
  const shop = path.join(e.dev, 'acme', 'shop'), api = path.join(shop, 'api');
  e.write('personal', 'a', ID(11), [user('old shop work', 1000, { cwd: shop }), user('more', 2000, { cwd: shop })]);
  e.write('personal', 'a', ID(12), [user('newer shop work', 5000, { cwd: shop })]);
  e.write('personal', 'b', ID(13), [user('api only', 9000, { cwd: api })]);
  e.write('company', 'a', ID(14), [user('company shop', 7000, { cwd: shop })]);
  e.start();
  assert.strictEqual((await h.latestFor(shop, 'personal')).id, ID(12));
  assert.strictEqual((await h.latestFor(shop, 'company')).id, ID(14));
  assert.strictEqual((await h.latestFor(api, 'personal')).id, ID(13));
  assert.strictEqual(await h.latestFor(path.join(e.dev, 'beta', 'app'), 'personal'), null);
  assert.strictEqual(await h.latestFor('relative/dir', 'personal'), null);
  e.live[ID(12)] = 'claude-shop';
  await h.refresh(true);
  assert.strictEqual((await h.latestFor(shop, 'personal')).live, 'claude-shop');
});
