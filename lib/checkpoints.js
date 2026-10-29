'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, writeJson, STATE, HOME, mapLimit } = require('./util');

const IN_TURN = new Set(['working', 'background', 'permission']);
const MAX_REPOS = 6, KEEP = 60, DROP_AFTER = 14 * 864e5, LIST_MAX = 200, OPEN_MAX = 12 * 3600e3;
const UNTRACKED_MAX = 5000, FILE_MAX = 20 * 2 ** 20, TOTAL_MAX = 200 * 2 ** 20, DIFF_MAX = 600 * 1024, SKIP_LIST = 500;
const SKIP_MARK = 'beast-dash-skipped: ';
const AUTHOR = { GIT_AUTHOR_NAME: 'beast-dash', GIT_AUTHOR_EMAIL: 'beast-dash@localhost', GIT_COMMITTER_NAME: 'beast-dash', GIT_COMMITTER_EMAIL: 'beast-dash@localhost' };

let FILE = path.join(STATE, 'checkpoints.json');
let db = null, saveT = null, seq = 0;
const chains = new Map();
const topCache = new Map();

function init(o = {}) {
  if (o.file) { FILE = o.file; db = null; }
}

function git(cwd, args, o = {}) {
  return new Promise(resolve => {
    let done = false; const out = [], err = []; let size = 0; const max = o.max || 64 * 2 ** 20;
    const fin = v => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    let ch;
    try { ch = spawn('git', ['--literal-pathspecs', ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(o.env || {}) } }); }
    catch (e) { return resolve({ ok: false, code: -1, stdout: '', stderr: e.message }); }
    const timer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} }, o.timeout || 60000);
    ch.stdout.on('data', d => { size += d.length; if (size <= max) out.push(d); });
    ch.stderr.on('data', d => { if (err.length < 64) err.push(d); });
    ch.stdin.on('error', () => {});
    ch.on('error', e => fin({ ok: false, code: -1, stdout: '', stderr: e.message }));
    ch.on('close', code => fin({ ok: code === 0, code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), truncated: size > max }));
    ch.stdin.end(o.input != null ? o.input : '');
  });
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
async function topOf(p) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return null;
  let dir = p;
  while (dir !== '/' && !isDir(dir)) dir = path.dirname(dir);
  if (dir === '/') return null;
  const c = topCache.get(dir); if (c && Date.now() - c.at < 600000) return c.top;
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  const top = r.ok && r.stdout.trim() && r.stdout.trim() !== HOME ? r.stdout.trim() : null;
  topCache.set(dir, { top, at: Date.now() });
  return top;
}

async function snapshot(top, msg) {
  const ip = await git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { timeout: 5000 });
  if (!ip.ok) return null;
  const tmp = path.join(os.tmpdir(), `bd-ckpt-${process.pid}-${Date.now()}-${++seq}.idx`);
  try {
    try { fs.copyFileSync(ip.stdout.trim(), tmp); } catch {}
    const env = { GIT_INDEX_FILE: tmp };
    if (!(await git(top, ['add', '-u'], { env, timeout: 120000 })).ok) return null;
    const un = await git(top, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 60000 });
    const pick = [], skipped = []; let total = 0, overflow = !un.ok || !!un.truncated;
    for (const f of un.stdout.split('\0')) {
      if (!f || f.endsWith('/')) continue;
      if (pick.length >= UNTRACKED_MAX) { overflow = true; break; }
      let st; try { st = fs.lstatSync(path.join(top, f)); } catch { continue; }
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      if (st.size > FILE_MAX || total + st.size > TOTAL_MAX) { if (skipped.length < SKIP_LIST) skipped.push(f); else overflow = true; continue; }
      total += st.size; pick.push(f);
    }
    if (skipped.length || overflow) msg += '\n\n' + SKIP_MARK + JSON.stringify({ overflow, paths: skipped });
    if (pick.length && !(await git(top, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: pick.join('\0'), timeout: 120000 })).ok) return null;
    const wt = await git(top, ['write-tree'], { env }); if (!wt.ok) return null;
    const head = await git(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { timeout: 5000 });
    const c = await git(top, ['commit-tree', '--no-gpg-sign', wt.stdout.trim(), ...(head.ok ? ['-p', head.stdout.trim()] : []), '-m', msg], { env: AUTHOR, timeout: 10000 });
    return c.ok ? c.stdout.trim() : null;
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

function parseNameStatus(text) {
  const out = new Map(); const a = text.split('\0');
  for (let i = 0; i + 1 < a.length; i += 2) { if (!a[i]) break; out.set(a[i + 1], a[i][0]); }
  return out;
}
async function stats(top, pre, post) {
  const ns = await git(top, ['diff', '--no-ext-diff', '--name-status', '-z', '--no-renames', pre, post]);
  const num = await git(top, ['diff', '--no-ext-diff', '--numstat', '-z', '--no-renames', pre, post]);
  if (!ns.ok) return null;
  const st = parseNameStatus(ns.stdout); const nums = new Map();
  for (const rec of num.stdout.split('\0')) { const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec); if (m) nums.set(m[3], [m[1] === '-' ? null : +m[1], m[2] === '-' ? null : +m[2]]); }
  let add = 0, del = 0; const list = [];
  for (const [f, s] of st) { const [a, d] = nums.get(f) || [null, null]; add += a || 0; del += d || 0; list.push({ f, s, a, d }); }
  return { files: list.length, add, del, list: list.slice(0, LIST_MAX) };
}

function load() {
  if (!db) { db = readJson(FILE, {}); if (!db || typeof db !== 'object' || Array.isArray(db)) db = {}; if (!db._known || typeof db._known !== 'object') db._known = {}; }
  return db;
}
function prune() {
  const d = load(); const now = Date.now();
  for (const name of Object.keys(d)) {
    if (name === '_known') continue;
    const list = d[name]; if (!Array.isArray(list)) { delete d[name]; continue; }
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    const newest = list.length ? list[list.length - 1].endAt || list[list.length - 1].startAt : 0;
    if (!list.length || now - newest > DROP_AFTER) delete d[name];
  }
  for (const name of Object.keys(d._known)) if (!d._known[name] || now - (d._known[name].at || 0) > DROP_AFTER) delete d._known[name];
}
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(flush, 300);
}
function flush() {
  clearTimeout(saveT); saveT = null;
  if (!db) return;
  try { writeJson(FILE, db); } catch (e) { console.error('checkpoints save', e.message); }
}

function queue(name, fn) {
  const prev = chains.get(name) || Promise.resolve();
  const next = prev.then(fn, fn).catch(e => console.error('checkpoints', name, e && e.message));
  chains.set(name, next);
  next.then(() => { if (chains.get(name) === next) chains.delete(name); });
  return next;
}

const openOf = name => (load()[name] || []).find(e => e.endAt == null) || null;
const uniq = a => [...new Set(a.filter(Boolean))];

async function reposFor(r) {
  const tops = [await topOf(r.cwd)];
  const dirs = uniq((r.touched || []).slice(0, 60).map(t => t && t.path && path.dirname(t.path)));
  for (const d of dirs) { tops.push(await topOf(d)); if (uniq(tops).length >= MAX_REPOS) break; }
  tops.push(...[...((load()._known[r.tmux] || {}).tops || [])].reverse());
  return uniq(tops).filter(isDir).slice(0, MAX_REPOS);
}

function begin(r) {
  const name = r.tmux; const startAt = Date.now(); const prompt = r.lastPrompt ? String(r.lastPrompt).slice(0, 200) : '';
  return queue(name, async () => {
    if (openOf(name)) await close(name, r, startAt);
    const d = load(); const list = d[name] || (d[name] = []);
    const e = { id: startAt.toString(36) + Math.random().toString(36).slice(2, 6), n: (list.length ? list[list.length - 1].n || 0 : 0) + 1, kind: 'turn', startAt, endAt: null, prompt, repos: [] };
    list.push(e); save();
    const tops = await reposFor(r);
    const pres = await mapLimit(tops, 3, top => snapshot(top, `beast-dash checkpoint before ${name} #${e.n}`));
    e.repos = tops.map((top, i) => ({ top, pre: pres[i], post: null, files: 0, add: 0, del: 0, list: [], others: [] })).filter(x => x.pre);
    save();
  });
}

function end(name, r) {
  const endAt = Date.now();
  return queue(name, () => close(name, r, endAt));
}

async function close(name, r, endAt) {
  const d = load(); const list = d[name] || []; const e = list.find(x => x.endAt == null); if (!e) return;
  e.endAt = endAt;
  if (r && Array.isArray(r.touched)) {
    const fresh = r.touched.filter(t => t && t.at >= e.startAt - 2000).map(t => path.dirname(t.path));
    const known = new Set((d._known[name] || {}).tops || []);
    for (const dir of uniq(fresh).slice(0, 40)) { const top = await topOf(dir); if (top) known.add(top); }
    for (const x of e.repos) known.add(x.top);
    d._known[name] = { tops: [...known].slice(-MAX_REPOS * 2), at: endAt };
  }
  await mapLimit(e.repos, 3, async x => {
    x.post = await snapshot(x.top, `beast-dash checkpoint after ${name} #${e.n}`);
    const s = x.post && await stats(x.top, x.pre, x.post);
    if (s) Object.assign(x, s);
    x.others = Object.keys(d).filter(o => o !== '_known' && o !== name && (d[o] || []).some(y => y.kind === 'turn' && y.startAt < e.endAt && (y.endAt == null || y.endAt > e.startAt) && y.repos.some(z => z.top === x.top)));
  });
  e.repos = e.repos.filter(x => x.post && x.files > 0);
  if (!e.repos.length) list.splice(list.indexOf(e), 1);
  prune(); save();
}

function sweep(stateOf) {
  const d = load(); const now = Date.now();
  for (const name of Object.keys(d)) {
    if (name === '_known') continue;
    const e = (d[name] || []).find(x => x.endAt == null); if (!e || chains.has(name)) continue;
    const st = stateOf(name);
    if (!st || !IN_TURN.has(st) || now - e.startAt > OPEN_MAX) end(name, null);
  }
}

function onChange(ev, r, prev) {
  if (!r || !r.tmux) return;
  const was = IN_TURN.has(prev && prev.state), now = IN_TURN.has(r.state);
  if (!was && now) begin(r);
  else if (was && !now) end(r.tmux, r);
}

function items(name) {
  return [...(load()[name] || [])].reverse();
}
function find(name, id) { return (load()[name] || []).find(e => e.id === id) || null; }
function busyIn(name, tops) {
  const d = load();
  return Object.keys(d).filter(o => o !== '_known' && o !== name && (d[o] || []).some(y => y.endAt == null && y.repos.some(z => tops.includes(z.top))));
}

async function diff(name, id, top, file) {
  const e = find(name, id); const x = e && e.repos.find(y => y.top === top);
  if (!x || !x.pre || !x.post) return { error: 'no such checkpoint' };
  const r = await git(x.top, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--no-renames', x.pre, x.post, ...(file ? ['--', file] : [])], { max: DIFF_MAX });
  if (!r.ok) return { error: /bad object|unknown revision|Invalid revision/i.test(r.stderr) ? 'this snapshot is gone (git gc removed it)' : (r.stderr.trim().split('\n').pop() || 'git diff failed') };
  return { text: r.stdout, truncated: !!r.truncated };
}

async function skippedIn(top, commit) {
  const r = await git(top, ['cat-file', 'commit', commit], { timeout: 5000 });
  const line = r.ok && r.stdout.split('\n').find(l => l.startsWith(SKIP_MARK));
  if (!line) return { overflow: false, paths: new Set() };
  try { const v = JSON.parse(line.slice(SKIP_MARK.length)); return { overflow: !!v.overflow, paths: new Set(Array.isArray(v.paths) ? v.paths : []) }; }
  catch { return { overflow: true, paths: new Set() }; }
}

const isRealDir = p => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

async function planRepo(x) {
  if (!(await git(x.top, ['cat-file', '-e', x.pre + '^{tree}'], { timeout: 5000 })).ok) return { top: x.top, error: 'this snapshot is gone (git gc removed it)' };
  const turn = await git(x.top, ['diff', '--no-ext-diff', '--name-only', '-z', '--no-renames', x.pre, x.post]);
  if (!turn.ok) return { top: x.top, error: 'git diff failed' };
  const paths = turn.stdout.split('\0').filter(Boolean);
  const now = await snapshot(x.top, 'beast-dash safety snapshot before undo');
  if (!now) return { top: x.top, error: 'could not snapshot the working tree' };
  const cur = parseNameStatus((await git(x.top, ['diff', '--no-ext-diff', '--name-status', '-z', '--no-renames', x.pre, now])).stdout);
  const later = parseNameStatus((await git(x.top, ['diff', '--no-ext-diff', '--name-status', '-z', '--no-renames', x.post, now])).stdout);
  const skip = await skippedIn(x.top, x.pre);
  const files = [];
  for (const f of paths) {
    const s = cur.get(f); if (!s) continue;
    const e = { f, act: s === 'A' ? 'delete' : 'restore', later: later.has(f) };
    if (e.act === 'delete' && (skip.overflow || skip.paths.has(f))) Object.assign(e, { act: 'keep', why: skip.paths.has(f) ? 'it was there before this turn but too big to snapshot' : 'the snapshot before this turn was partial, so it may have been there already' });
    else if (e.act === 'restore' && isRealDir(path.join(x.top, f))) Object.assign(e, { act: 'keep', why: 'a folder is in its place now' });
    files.push(e);
  }
  const head = await git(x.top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { timeout: 5000 });
  const base = await git(x.top, ['rev-parse', '-q', '--verify', x.pre + '^1'], { timeout: 5000 });
  return { top: x.top, now, files, headMoved: head.ok && base.ok && head.stdout.trim() !== base.stdout.trim() };
}

function rmEmptyDirs(top, f) {
  let dir = path.dirname(path.join(top, f));
  while (dir.length > top.length && dir.startsWith(top + '/')) { try { fs.rmdirSync(dir); } catch { return; } dir = path.dirname(dir); }
}

async function applyRepo(x, plan) {
  const restore = plan.files.filter(f => f.act === 'restore').map(f => f.f);
  const del = plan.files.filter(f => f.act === 'delete').map(f => f.f);
  if (restore.length) {
    const tmp = path.join(os.tmpdir(), `bd-ckpt-${process.pid}-${Date.now()}-${++seq}.idx`);
    try {
      const env = { GIT_INDEX_FILE: tmp };
      if (!(await git(x.top, ['read-tree', x.pre], { env })).ok) return 'git read-tree failed';
      const co = await git(x.top, ['checkout-index', '-f', '-z', '--stdin'], { env, input: restore.join('\0') + '\0', timeout: 120000 });
      if (!co.ok) return 'git checkout-index failed: ' + co.stderr.trim().split('\n').pop();
    } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }
  for (const f of del) {
    const abs = path.join(x.top, f); if (!abs.startsWith(x.top + '/')) continue;
    try { fs.unlinkSync(abs); rmEmptyDirs(x.top, f); } catch {}
  }
  return null;
}

function restore(name, id, o = {}) {
  return queue(name, async () => {
    const e = find(name, id);
    if (!e) return { ok: false, error: 'no such checkpoint' };
    if (e.endAt == null) return { ok: false, error: 'that turn is still running' };
    const repos = e.repos.filter(x => x.pre && x.post && (!o.top || x.top === o.top));
    if (!repos.length) return { ok: false, error: 'nothing to undo' };
    const plans = await mapLimit(repos, 3, planRepo);
    const others = uniq([...repos.flatMap(x => x.others || []), ...busyIn(name, repos.map(x => x.top))]);
    const view = plans.map(p => ({ top: p.top, error: p.error || null, headMoved: !!p.headMoved, files: p.files || [] }));
    const idle = p => p.error || !p.files.some(f => f.act !== 'keep');
    if (o.dry || plans.every(idle)) return { ok: true, dry: !!o.dry, repos: view, others, nothing: plans.every(idle) };
    const u = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), n: e.n, kind: 'undo', of: e.id, startAt: Date.now(), endAt: Date.now(), prompt: `Undo of turn #${e.n}` + (e.prompt ? ': ' + e.prompt.slice(0, 120) : ''), repos: [] };
    const errors = [];
    for (let i = 0; i < repos.length; i++) {
      const p = plans[i]; if (idle(p)) continue;
      const err = await applyRepo(repos[i], p); if (err) { errors.push(p.top + ': ' + err); continue; }
      const post = await snapshot(p.top, `beast-dash after undo of ${name} #${e.n}`);
      const s = post && await stats(p.top, p.now, post);
      if (s && s.files) u.repos.push({ top: p.top, pre: p.now, post, ...s, others: [] });
    }
    if (u.repos.length) { (load()[name] || (load()[name] = [])).push(u); prune(); save(); }
    return { ok: !errors.length, error: errors.join('; ') || null, repos: view, others, undo: u.repos.length ? u.id : null };
  });
}

module.exports = { init, onChange, begin, end, sweep, items, find, diff, restore, snapshot, topOf, flush, IN_TURN };
