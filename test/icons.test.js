const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const icons = require('../lib/icons');

const PNG = n => Buffer.alloc(n, 1);

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-icons-')));
  const dev = path.join(root, 'dev');
  const out = path.join(root, 'icons');
  const put = (rel, data) => { const f = path.join(dev, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  icons.init({ dir: out });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dev, out, put };
}

test('expo app.json icon wins over others', t => {
  const { dev, put } = setup(t);
  put('a/app/app.json', JSON.stringify({ expo: { icon: './assets/brand.png' } }));
  put('a/app/assets/brand.png', PNG(10));
  put('a/app/public/favicon.ico', PNG(5));
  assert.strictEqual(path.basename(icons.find(path.join(dev, 'a/app')).file), 'brand.png');
});

test('next app/icon, public walk prefers svg, skips background', t => {
  const { dev, put } = setup(t);
  put('a/next/app/icon.png', PNG(20));
  assert.strictEqual(path.basename(icons.find(path.join(dev, 'a/next')).file), 'icon.png');
  put('a/web/public/icons/icon-512.png', PNG(400));
  put('a/web/public/icon-background.png', PNG(900));
  put('a/web/public/favicon.svg', '<svg/>');
  assert.strictEqual(path.basename(icons.find(path.join(dev, 'a/web')).file), 'favicon.svg');
  fs.rmSync(path.join(dev, 'a/web/public/favicon.svg'));
  assert.strictEqual(path.basename(icons.find(path.join(dev, 'a/web')).file), 'icon-512.png');
});

test('android mipmap and largest iOS AppIcon', t => {
  const { dev, put } = setup(t);
  put('a/droid/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', PNG(30));
  put('a/droid/app/src/main/res/mipmap-hdpi/ic_launcher.png', PNG(90));
  assert.match(icons.find(path.join(dev, 'a/droid')).file, /mipmap-xxxhdpi/);
  put('a/ios/App/Images.xcassets/AppIcon.appiconset/icon-60.png', PNG(60));
  put('a/ios/App/Images.xcassets/AppIcon.appiconset/icon-1024.png', PNG(1024));
  assert.strictEqual(path.basename(icons.find(path.join(dev, 'a/ios')).file), 'icon-1024.png');
});

test('size limit, bad extension and symlink escape are refused', t => {
  const { root, dev, put } = setup(t);
  put('a/big/app/icon.png', PNG(512 * 1024 + 1));
  assert.strictEqual(icons.find(path.join(dev, 'a/big')), null);
  put('a/txt/public/favicon.txt', 'x');
  assert.strictEqual(icons.find(path.join(dev, 'a/txt')), null);
  const secret = path.join(root, 'secret.png'); fs.writeFileSync(secret, PNG(10));
  fs.mkdirSync(path.join(dev, 'a/esc/app'), { recursive: true });
  fs.symlinkSync(secret, path.join(dev, 'a/esc/app/icon.png'));
  assert.strictEqual(icons.find(path.join(dev, 'a/esc')), null);
  put('a/exp/app.json', JSON.stringify({ expo: { icon: '../../../secret.png' } }));
  assert.strictEqual(icons.find(path.join(dev, 'a/exp')), null);
});

test('refresh copies, decorates, serves with CSP and removes stale', t => {
  const { dev, out, put } = setup(t);
  put('a/one/public/favicon.svg', '<svg><script>alert(1)</script></svg>');
  put('a/two/app/icon.png', PNG(10));
  const projects = [
    { id: 'a--one', dirName: 'one', framework: 'vite', path: path.join(dev, 'a/one') },
    { id: 'a--two', dirName: 'two', stack: 'python', path: path.join(dev, 'a/two') },
    { id: 'a--none', dirName: 'none', path: path.join(dev, 'a/none') },
    { id: '../bad', dirName: 'bad', path: path.join(dev, 'a/one') },
  ];
  icons.refresh(projects); icons.decorate(projects);
  assert.match(projects[0].icon, /^\/api\/icon\/a--one\?v=\d+$/);
  assert.strictEqual(projects[0].tech, 'vite');
  assert.strictEqual(projects[1].tech, 'python');
  assert.strictEqual(projects[2].icon, null);
  assert.strictEqual(projects[2].tech, 'other');
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['a--one.svg', 'a--two.png', 'index.json']);
  const f = icons.file('a--one');
  assert.strictEqual(f.type, 'image/svg+xml');
  assert.match(icons.HEADERS['content-security-policy'], /sandbox/);
  assert.strictEqual(icons.HEADERS['x-content-type-options'], 'nosniff');
  assert.strictEqual(icons.file('../bad'), null);
  assert.strictEqual(icons.file('a--none'), null);

  fs.rmSync(path.join(dev, 'a/one/public/favicon.svg'));
  icons.refresh(projects.slice(0, 1));
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['index.json']);

  fs.writeFileSync(path.join(out, 'org-acme.png'), PNG(4));
  assert.strictEqual(icons.file('org-acme').type, 'image/png');
});

test('techOf maps frameworks and stacks', () => {
  assert.strictEqual(icons.techOf({ framework: 'cra' }), 'react');
  assert.strictEqual(icons.techOf({ framework: 'hono' }), 'node');
  assert.strictEqual(icons.techOf({ framework: 'next' }), 'next');
  assert.strictEqual(icons.techOf({ stack: 'swift' }), 'ios');
  assert.strictEqual(icons.techOf({ stack: 'dart' }), 'flutter');
  assert.strictEqual(icons.techOf({ dirName: 'foo-android' }), 'android');
  assert.strictEqual(icons.techOf({ dirName: 'x' }), 'other');
});

const REALPNG = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 2)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="512" height="512"/><use href="#g"/></svg>';
const touch = (f, ms) => { const t = new Date(ms); fs.utimesSync(f, t, t); };
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('custom icon wins over the auto one, newest custom wins, removal falls back', t => {
  const { dev, out, put } = setup(t);
  put('a/one/app/icon.png', PNG(10));
  const projects = [{ id: 'a--one', dirName: 'one', path: path.join(dev, 'a/one') }];
  icons.refresh(projects); icons.decorate(projects);
  assert.match(projects[0].icon, /\?v=\d+$/);
  assert.strictEqual(projects[0].iconCustom, false);

  fs.mkdirSync(path.join(out, 'custom'));
  const c1 = path.join(out, 'custom', 'a--one.png'); fs.writeFileSync(c1, REALPNG(20)); touch(c1, 1_700_000_000_000);
  icons.refresh(projects); icons.decorate(projects);
  assert.strictEqual(projects[0].icon, '/api/icon/a--one?v=c1700000000000');
  assert.strictEqual(projects[0].iconCustom, true);
  assert.strictEqual(icons.file('a--one').file, c1);
  assert.ok(!fs.existsSync(path.join(out, 'a--one.png')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'))['a--one'].custom, true);

  const c2 = path.join(out, 'custom', 'a--one.svg'); fs.writeFileSync(c2, SVG); touch(c2, 1_700_000_100_000);
  icons.poll(projects, true);
  assert.strictEqual(projects[0].icon, '/api/icon/a--one?v=c1700000100000');
  assert.strictEqual(icons.file('a--one').type, 'image/svg+xml');

  fs.writeFileSync(c2, SVG.replace('<rect', '<rect onload="x()"')); touch(c2, 1_700_000_200_000);
  icons.poll(projects, true);
  assert.strictEqual(projects[0].icon, '/api/icon/a--one?v=c1700000000000', 'an unsafe newer svg is ignored');

  fs.rmSync(c1); fs.rmSync(c2);
  icons.poll(projects, true);
  assert.match(projects[0].icon, /^\/api\/icon\/a--one\?v=\d+$/);
  assert.strictEqual(projects[0].iconCustom, false);
  assert.strictEqual(path.basename(icons.file('a--one').file), 'a--one.png');
});

test('a dropped file shows up on poll without a rescan; poll is throttled', t => {
  const { dev, out } = setup(t);
  const projects = [{ id: 'a--none', dirName: 'none', org: 'acme', path: path.join(dev, 'a/none') }];
  icons.refresh(projects); icons.decorate(projects);
  assert.strictEqual(projects[0].icon, null);
  assert.strictEqual(projects[0].orgIcon, null);
  fs.mkdirSync(path.join(out, 'custom'));
  fs.writeFileSync(path.join(out, 'custom', 'a--none.svg'), SVG);
  icons.poll(projects, true);
  assert.match(projects[0].icon, /^\/api\/icon\/a--none\?v=c\d+$/);
  fs.writeFileSync(path.join(out, 'custom', 'org-acme.svg'), SVG);
  assert.strictEqual(icons.poll(projects), false);
  icons.poll(projects, true);
  assert.match(projects[0].orgIcon, /^\/api\/icon\/org-acme\?v=c\d+$/);
  assert.strictEqual(projects[0].orgIconCustom, true);
});

test('org: custom wins over the org file in the icons folder', t => {
  const { out } = setup(t);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'org-acme.png'), PNG(4));
  const projects = [{ id: 'x', dirName: 'x', org: 'acme', path: '/nonexistent' }];
  icons.decorate(projects);
  assert.match(projects[0].orgIcon, /^\/api\/icon\/org-acme\?v=\d+$/);
  assert.strictEqual(icons.file('org-acme').type, 'image/png');
  assert.deepStrictEqual(icons.saveCustom('org-acme', 'svg', Buffer.from(SVG)), { ok: true, name: 'org-acme.svg' });
  assert.strictEqual(icons.file('org-acme').type, 'image/svg+xml');
  icons.decorate(projects);
  assert.strictEqual(projects[0].orgIconCustom, true);
  assert.deepStrictEqual(icons.removeCustom('org-acme'), { ok: true, removed: true });
  assert.strictEqual(icons.file('org-acme').type, 'image/png');
  assert.ok(fs.existsSync(path.join(out, 'org-acme.png')));
});

test('upload validation: key, extension, size, content and svg safety', t => {
  setup(t);
  const b64 = b => Buffer.from(b).toString('base64');
  assert.strictEqual(icons.keyFor('project', 'a--one'), 'a--one');
  assert.strictEqual(icons.keyFor('project', 'org-x'), null);
  assert.strictEqual(icons.keyFor('project', '../x'), null);
  assert.strictEqual(icons.keyFor('org', 'acme'), 'org-acme');
  assert.strictEqual(icons.keyFor('org', '.hidden'), null);
  assert.strictEqual(icons.keyFor('file', 'a'), null);

  assert.strictEqual(icons.saveCustom('../x', 'svg', b64(SVG)).ok, false);
  assert.match(icons.saveCustom('p', 'gif', b64('GIF89a')).error, /unsupported/);
  assert.match(icons.saveCustom('p', 'constructor', b64(SVG)).error, /unsupported/);
  assert.match(icons.saveCustom('p', 'png', 'not base64!').error, /base64/);
  assert.match(icons.saveCustom('p', 'png', b64('hello')).error, /not a valid png/);
  assert.match(icons.saveCustom('p', 'png', REALPNG(icons.MAX)).error, /too big/);
  assert.match(icons.saveCustom('p', 'png', b64(REALPNG(icons.MAX))).error, /base64|too big/);
  assert.strictEqual(icons.saveCustom('p', 'png', 'data:image/png;base64,' + b64(REALPNG(100))).ok, true);
  assert.strictEqual(icons.saveCustom('p', 'JPG', b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).ok, true);
  assert.strictEqual(icons.file('p').type, 'image/jpeg');

  const bad = [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><rect\nonclick=x() /></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><image href="https://evil.example/x.png"/></svg>',
    '<svg><use xlink:href="other.svg#a"/></svg>',
    '<svg><image href="data:image/png;base64,AAAA"/></svg>',
    '<svg><rect style="fill:url(https://evil.example/a)"/></svg>',
    '<svg><style>@import "x.css";</style></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    '<html><body>no svg</body></html>',
  ];
  for (const s of bad) assert.strictEqual(icons.svgSafe(s), false, s);
  for (const s of bad) assert.strictEqual(icons.saveCustom('p', 'svg', b64(s)).ok, false, s);
  assert.strictEqual(icons.svgSafe(SVG), true);
  assert.strictEqual(icons.svgSafe('<svg viewBox="0 0 1 1"><g font-family="x" stroke-linejoin="round"/></svg>'), true);
});

test('reset removes every custom variant and is a no-op when none exists', t => {
  const { out } = setup(t);
  assert.strictEqual(icons.saveCustom('p', 'svg', Buffer.from(SVG)).ok, true);
  fs.writeFileSync(path.join(out, 'custom', 'p.png'), REALPNG(5));
  assert.deepStrictEqual(icons.removeCustom('p'), { ok: true, removed: true });
  assert.deepStrictEqual(fs.readdirSync(path.join(out, 'custom')), []);
  assert.strictEqual(icons.file('p'), null);
  assert.deepStrictEqual(icons.removeCustom('p'), { ok: true, removed: false });
  assert.strictEqual(icons.removeCustom('../p').ok, false);
});

test('upload replaces the other extension; prompts name the absolute target', t => {
  const { out } = setup(t);
  icons.saveCustom('p', 'png', REALPNG(5));
  icons.saveCustom('p', 'svg', Buffer.from(SVG));
  assert.deepStrictEqual(fs.readdirSync(path.join(out, 'custom')), ['p.svg']);
  const target = icons.customTarget('q');
  assert.strictEqual(target, path.join(out, 'custom', 'q.svg'));
  assert.ok(fs.statSync(path.dirname(target)).isDirectory());
  assert.strictEqual(icons.customTarget('../q'), null);
  assert.match(icons.askPrompt('project', { name: 'one', target }), new RegExp(`Write the SVG to ${reEsc(target)} and nothing else`));
  assert.match(icons.askPrompt('org', { name: 'acme', target }), /"acme" organisation[\s\S]*across its projects/);
  const b = icons.askPrompt('batch', { items: [{ name: 'one', path: '/d/one', target: '/s/one.svg' }, { name: 'two', path: '/d/two', target: '/s/two.svg' }] });
  assert.match(b, /- one \(\/d\/one\) -> \/s\/one\.svg\n- two \(\/d\/two\) -> \/s\/two\.svg$/);
  assert.match(b, /viewBox="0 0 512 512"/);
});
