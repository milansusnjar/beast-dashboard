'use strict';
const fs = require('fs');
const path = require('path');
const { STATE, readJson, writeJson } = require('./util');

const MAX = 512 * 1024;
const EXT = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const FIXED = ['app/icon.png', 'app/icon.svg', 'src/app/icon.png', 'src/app/icon.svg', 'app/favicon.ico', 'src/app/favicon.ico'];
const LATE = ['assets/icon.png', 'assets/images/icon.png', 'src/assets/images/icon.png', 'src/assets/icon.png'];
const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'Pods', '.next', '.nuxt', '.expo', 'DerivedData', 'vendor', 'coverage', '.gradle', 'out', 'tmp', '.venv', 'venv', '__pycache__', 'target', '.cache', '.turbo', '.idea', '.vscode']);
const WEB = /^(favicon|icon|apple-touch-icon|logo)(?!.*(background|splash|-bg|_bg))[\w.-]*$/i;
const TECH = new Set(['next', 'react', 'expo', 'react-native', 'angular', 'nuxt', 'vue', 'nest', 'express', 'fastify', 'node', 'python', 'django', 'fastapi', 'flask', 'flutter', 'rust', 'go', 'docker', 'android', 'ios', 'vite', 'other']);

let dir = path.join(STATE, 'icons');
let index = null;
let cust = { sig: null, map: new Map() };
let lastMap = null, lastPoll = 0;

function init(opts = {}) { if (opts.dir) dir = opts.dir; index = null; cust = { sig: null, map: new Map() }; lastMap = null; lastPoll = 0; }
const indexFile = () => path.join(dir, 'index.json');
function load() { if (!index) { index = readJson(indexFile(), {}); if (!index || typeof index !== 'object') index = {}; } return index; }

const extOf = f => path.extname(f).slice(1).toLowerCase();

function usable(root, file) {
  if (!EXT[extOf(file)]) return null;
  let real, st;
  try { real = fs.realpathSync(file); st = fs.statSync(real); } catch { return null; }
  if (!st.isFile() || st.size === 0 || st.size > MAX) return null;
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  return { file: real, size: st.size, mtime: Math.trunc(st.mtimeMs) };
}

function walk(root, sub, depth, fn) {
  const go = (d, left) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (left > 0 && !SKIP.has(e.name)) go(path.join(d, e.name), left - 1); }
      else if (e.isFile()) fn(path.join(d, e.name), e.name, d);
    }
  };
  go(path.join(root, sub), depth);
}

const rank = u => { const e = extOf(u.file); const n = path.basename(u.file).toLowerCase(); return (e === 'svg' ? 0 : e === 'ico' ? 2000 : 1000) + (n.startsWith('logo') ? 100 : 0); };
function pick(list) { return list.sort((a, b) => rank(a) - rank(b) || b.size - a.size)[0] || null; }

function webIcon(root, sub, depth) {
  const found = [];
  walk(root, sub, depth, (f, n) => { if (WEB.test(n)) { const u = usable(root, f); if (u) found.push(u); } });
  return pick(found);
}

function nativeIcon(root) {
  const android = [], ios = [];
  walk(root, '', 6, (f, n, d) => {
    const parent = path.basename(d);
    if (n === 'ic_launcher.png' && parent === 'mipmap-xxxhdpi') { const u = usable(root, f); if (u) android.push(u); }
    else if (parent === 'AppIcon.appiconset' && extOf(n) === 'png') { const u = usable(root, f); if (u) ios.push(u); }
  });
  const big = l => l.sort((a, b) => b.size - a.size)[0] || null;
  return big(android) || big(ios);
}

function expoIcon(root) {
  const cfg = readJson(path.join(root, 'app.json'), null);
  const rel = cfg && cfg.expo && typeof cfg.expo.icon === 'string' ? cfg.expo.icon : null;
  return rel ? usable(root, path.resolve(root, rel)) : null;
}

function find(projectPath) {
  let root; try { root = fs.realpathSync(projectPath); } catch { return null; }
  const fixed = list => { for (const r of list) { const u = usable(root, path.join(root, r)); if (u) return u; } return null; };
  return expoIcon(root) || fixed(FIXED) || webIcon(root, 'public', 4) || webIcon(root, 'static', 2) || fixed(LATE) || webIcon(root, 'src/assets', 2) || nativeIcon(root);
}

function techOf(p) {
  const f = p.framework, s = p.stack, base = String(p.dirName || '');
  if (f === 'cra') return 'react';
  if (f === 'koa' || f === 'hono' || f === 'hapi') return 'node';
  if (f && TECH.has(f)) return f;
  if (s === 'swift') return 'ios';
  if (s === 'dart') return 'flutter';
  if (s === 'python' || s === 'rust' || s === 'go' || s === 'docker' || s === 'node') return s;
  if (/android/.test(base)) return 'android';
  if (/-ios$|ios/.test(base)) return 'ios';
  return 'other';
}

const customDir = () => path.join(dir, 'custom');
const keyOk = k => typeof k === 'string' && ID.test(k);

const SVG_BAD = [/<script/i, /[\s"'/;]on[a-z0-9_-]+\s*=/i, /javascript\s*:/i, /<!(doctype|entity)/i, /<foreignobject/i, /<(iframe|embed|object|audio|video|link|meta|base)\b/i, /@import/i];
function svgSafe(text) {
  if (typeof text !== 'string' || !/<svg[\s>]/i.test(text)) return false;
  if (SVG_BAD.some(r => r.test(text))) return false;
  for (const m of text.matchAll(/href\s*=\s*["']?\s*([^"'\s>]*)/gi)) if (!m[1].startsWith('#')) return false;
  for (const m of text.matchAll(/url\(\s*["']?\s*([^"')\s]*)/gi)) if (!m[1].startsWith('#')) return false;
  return true;
}

function contentOk(ext, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX) return false;
  switch (ext) {
    case 'png': return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg': case 'jpeg': return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'webp': return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'ico': return buf.length > 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0;
    case 'svg': return svgSafe(buf.toString('utf8'));
    default: return false;
  }
}

function customs() {
  const d = customDir(); let names = [];
  try { names = fs.readdirSync(d); } catch {}
  const list = [];
  for (const n of names) {
    const m = /^(.+)\.([a-z]+)$/.exec(n);
    if (!m || !Object.hasOwn(EXT, m[2]) || !keyOk(m[1])) continue;
    let st; try { st = fs.lstatSync(path.join(d, n)); } catch { continue; }
    if (!st.isFile() || st.size === 0 || st.size > MAX) continue;
    list.push({ key: m[1], name: n, mtime: Math.trunc(st.mtimeMs), size: st.size });
  }
  const sig = list.map(x => `${x.name}:${x.mtime}:${x.size}`).sort().join('|');
  if (sig === cust.sig) return cust.map;
  const map = new Map();
  for (const x of list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))) {
    if (map.has(x.key)) continue;
    let buf; try { buf = fs.readFileSync(path.join(d, x.name)); } catch { continue; }
    if (contentOk(extOf(x.name), buf)) map.set(x.key, x);
  }
  cust = { sig, map };
  return map;
}

const dropFile = name => fs.rmSync(path.join(dir, name), { force: true });
const projectOk = p => p && ID.test(p.id || '') && !p.id.startsWith('org-') && p.path;

function update(p, map) {
  const c = map.get(p.id); let old = index[p.id]; let changed = false;
  if (c) {
    const name = 'custom/' + c.name;
    if (old && old.custom && old.name === name && old.mtime === c.mtime && old.size === c.size) return false;
    if (old && !old.custom) dropFile(old.name);
    index[p.id] = { name, custom: true, mtime: c.mtime, size: c.size };
    return true;
  }
  if (old && old.custom) { delete index[p.id]; old = undefined; changed = true; }
  const hit = find(p.path);
  if (!hit) { if (old) { dropFile(old.name); delete index[p.id]; changed = true; } return changed; }
  if (old && old.src === hit.file && old.mtime === hit.mtime && old.size === hit.size && fs.existsSync(path.join(dir, old.name))) return changed;
  const name = `${p.id}.${extOf(hit.file)}`;
  try {
    const tmp = path.join(dir, name + '.tmp');
    fs.copyFileSync(hit.file, tmp); fs.renameSync(tmp, path.join(dir, name));
    if (old && old.name !== name) dropFile(old.name);
    index[p.id] = { name, src: hit.file, mtime: hit.mtime, size: hit.size };
    changed = true;
  } catch (e) { console.error('icon copy failed', p.id, e.message); }
  return changed;
}

function refresh(projects) {
  load();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const map = customs(); let changed = false;
  for (const p of projects || []) if (projectOk(p) && update(p, map)) changed = true;
  for (const id of Object.keys(index)) if (!(projects || []).some(p => p && p.id === id)) { if (!index[id].custom) dropFile(index[id].name); delete index[id]; changed = true; }
  if (changed) writeJson(indexFile(), index);
  lastMap = map;
  return index;
}

function poll(projects, force) {
  if (!force && Date.now() - lastPoll < 1500) return false;
  lastPoll = Date.now();
  try {
    load();
    const map = customs();
    if (map !== lastMap) {
      let changed = false;
      for (const p of projects || []) if (projectOk(p) && (map.has(p.id) || (index[p.id] && index[p.id].custom)) && update(p, map)) changed = true;
      if (changed) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); writeJson(indexFile(), index); }
      lastMap = map;
    }
    decorate(projects);
    return true;
  } catch (e) { console.error('icon poll failed', e.message); return false; }
}

function orgFile(name, map) {
  if (!keyOk(name)) return null;
  const c = (map || customs()).get('org-' + name);
  if (c) return { file: path.join(customDir(), c.name), type: EXT[extOf(c.name)], mtime: c.mtime, custom: true };
  for (const e of Object.keys(EXT)) {
    const f = path.join(dir, `org-${name}.${e}`);
    try { const st = fs.statSync(f); if (st.isFile() && st.size <= MAX) return { file: f, type: EXT[e], mtime: Math.trunc(st.mtimeMs), custom: false }; } catch {}
  }
  return null;
}

function decorate(projects) {
  load();
  const map = customs(); const orgs = new Map();
  for (const p of projects || []) {
    if (!p) continue;
    const i = index[p.id];
    p.icon = i ? `/api/icon/${encodeURIComponent(p.id)}?v=${i.custom ? 'c' : ''}${i.mtime}` : null;
    p.iconCustom = !!(i && i.custom);
    p.tech = techOf(p);
    if (typeof p.org === 'string' && p.org) {
      if (!orgs.has(p.org)) { const o = orgFile(p.org, map); orgs.set(p.org, o ? { url: `/api/icon/org-${encodeURIComponent(p.org)}?v=${o.custom ? 'c' : ''}${o.mtime}`, custom: o.custom } : null); }
      const o = orgs.get(p.org);
      p.orgIcon = o ? o.url : null; p.orgIconCustom = !!(o && o.custom);
    }
  }
  return projects;
}

function file(id) {
  if (!keyOk(id)) return null;
  load();
  const c = customs().get(id);
  if (c) return { file: path.join(customDir(), c.name), type: EXT[extOf(c.name)] };
  const i = index[id];
  if (i && !i.custom) { const f = path.join(dir, i.name); return fs.existsSync(f) ? { file: f, type: EXT[extOf(i.name)] } : null; }
  if (i) return null;
  const m = /^org-(.+)$/.exec(id);
  if (!m) return null;
  const o = orgFile(m[1]);
  return o ? { file: o.file, type: o.type } : null;
}

function keyFor(kind, id) {
  if (kind === 'project') return keyOk(id) && !id.startsWith('org-') ? id : null;
  if (kind === 'org') return keyOk(id) ? 'org-' + id : null;
  return null;
}

function decode(data) {
  if (typeof data !== 'string') return null;
  const b64 = data.replace(/^data:[\w.+/-]*;base64,/, '').replace(/\s+/g, '');
  if (!b64 || b64.length > Math.ceil(MAX / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  return Buffer.from(b64, 'base64');
}

function validate(ext, buf) {
  const e = typeof ext === 'string' ? ext.toLowerCase() : '';
  if (!Object.hasOwn(EXT, e)) return 'unsupported file type (svg, png, jpg, webp, ico)';
  if (!Buffer.isBuffer(buf) || !buf.length) return 'empty or unreadable file';
  if (buf.length > MAX) return `too big (max ${MAX / 1024} KB)`;
  if (!contentOk(e, buf)) return e === 'svg' ? 'svg rejected: scripts, event handlers, javascript: and external references are not allowed' : `not a valid ${e} file`;
  return null;
}

function removeVariants(key, keep) {
  for (const e of Object.keys(EXT)) { const n = `${key}.${e}`; if (n !== keep) fs.rmSync(path.join(customDir(), n), { force: true }); }
}

function ensureCustomDir() { fs.mkdirSync(customDir(), { recursive: true }); return customDir(); }

function saveCustom(key, ext, data) {
  if (!keyOk(key)) return { ok: false, error: 'bad id' };
  if (Buffer.isBuffer(data) && data.length > MAX) return { ok: false, error: `too big (max ${MAX / 1024} KB)` };
  const buf = Buffer.isBuffer(data) ? data : decode(data);
  if (!buf) return { ok: false, error: `data must be base64, at most ${MAX / 1024} KB decoded` };
  const err = validate(ext, buf); if (err) return { ok: false, error: err };
  const name = `${key}.${ext.toLowerCase()}`;
  ensureCustomDir();
  const tmp = path.join(customDir(), `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, path.join(customDir(), name));
  removeVariants(key, name);
  cust.sig = null;
  return { ok: true, name };
}

function removeCustom(key) {
  if (!keyOk(key)) return { ok: false, error: 'bad id' };
  const had = Object.keys(EXT).some(e => fs.existsSync(path.join(customDir(), `${key}.${e}`)));
  removeVariants(key, null);
  cust.sig = null;
  return { ok: true, removed: had };
}

function customTarget(key) { return keyOk(key) ? path.join(ensureCustomDir(), `${key}.svg`) : null; }

const RULES = 'as a single self-contained SVG file: viewBox="0 0 512 512", no <script>, no event handler attributes, no javascript:, no external references (href and url() may only point to #ids inside the same file), no embedded raster images, no <foreignObject>, and no text unless it is the logo itself. Keep it bold and recognisable at 24 px.';
function askPrompt(kind, opts) {
  if (kind === 'project') return [`Design a distinctive square app icon for this project (${opts.name}) ${RULES}`, '', 'Look at the README and the code in this folder to understand what it is and pick a fitting motif.', '', `Write the SVG to ${opts.target} and nothing else. Do not change any other file.`].join('\n');
  if (kind === 'org') return [`Design a distinctive square icon for the "${opts.name}" organisation ${RULES}`, '', 'Look across its projects in this folder (names, READMEs, code) to understand what they have in common and pick a motif that represents the whole group.', '', `Write the SVG to ${opts.target} and nothing else. Do not change any other file.`].join('\n');
  if (kind === 'batch') return [`Design a distinctive square app icon for each project below, each ${RULES}`, '', 'For each project, look at its README and code to understand what it is. Give each one its own motif so they are easy to tell apart. You may use parallel subagents.', '', 'Write each SVG to exactly its target path and nothing else. Do not change any other file.', '', ...opts.items.map(x => `- ${x.name} (${x.path}) -> ${x.target}`)].join('\n');
  return null;
}

const HEADERS = { 'cache-control': 'max-age=3600', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff' };

module.exports = { init, find, refresh, poll, decorate, file, techOf, keyFor, svgSafe, validate, saveCustom, removeCustom, customTarget, askPrompt, MAX, EXT, HEADERS };
