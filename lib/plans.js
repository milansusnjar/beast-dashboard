'use strict';
// Plans and progress: docs/<topic>/PLAN.md + PROGRESS.md in a project. Read-only.
const fs = require('fs');
const path = require('path');

const TOPIC_RE = /^[\w.-]+$/;
const MAX_FILE = 400 * 1024;
const TTL = 30000;

// per-file cache keyed by path: re-read only when the mtime changed
const fileCache = new Map();   // fp -> { mtimeMs, size, text, parsed }
function readCached(fp) {
  let st; try { st = fs.statSync(fp); } catch { fileCache.delete(fp); return null; }
  if (!st.isFile()) return null;
  const c = fileCache.get(fp);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
  if (st.size > MAX_FILE * 4) return null;
  let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { return null; }
  const n = { mtimeMs: st.mtimeMs, size: st.size, text, parsed: null };
  fileCache.set(fp, n);
  return n;
}

function parseProgress(text) {
  const items = []; let section = null; let inCode = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*(```|~~~)/.test(ln)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const hm = ln.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (hm) { section = hm[1] || null; continue; }
    const m = ln.match(/^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    items.push({ line: i + 1, text: m[3].trim(), done: m[2] !== ' ', depth: Math.floor(indent / 2), section });
  }
  const done = items.filter(x => x.done).length;
  return { done, total: items.length, items };
}
function progressOf(c) { if (!c.parsed) c.parsed = parseProgress(c.text); return c.parsed; }

// Symlink containment: a path is only read when its realpath is inside realpath(<project>/docs).
// A cloned repo must not be able to serve e.g. docs/x/PLAN.md -> ~/.claude/... or a symlinked topic dir.
function inDocs(root, p) {
  try {
    const base = fs.realpathSync(path.join(root, 'docs'));
    const real = fs.realpathSync(p);
    return real === base || real.startsWith(base + path.sep);
  } catch { return false; }
}
function readIn(root, fp) { return inDocs(root, fp) ? readCached(fp) : null; }

function listTopics(root) {
  let ents; try { ents = fs.readdirSync(path.join(root, 'docs'), { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && TOPIC_RE.test(e.name) && inDocs(root, path.join(root, 'docs', e.name))).map(e => e.name).sort();
}

function topicSummary(root, topic) {
  const dir = path.join(root, 'docs', topic);
  const pr = readIn(root, path.join(dir, 'PROGRESS.md'));
  const pl = readIn(root, path.join(dir, 'PLAN.md'));
  if (!pr && !pl) return null;
  let done = 0, total = 0, next = null;
  if (pr) { const p = progressOf(pr); done = p.done; total = p.total; const n = p.items.find(x => !x.done); if (n) next = n.text.slice(0, 140); }
  return { topic, done, total, next, mtime: Math.round(Math.max(pr ? pr.mtimeMs : 0, pl ? pl.mtimeMs : 0)) };
}

let sumCache = { t: 0, key: '', val: {} };
function summary(projects) {
  const key = (projects || []).map(p => p.id + '\0' + p.path).join('\n');
  if (key === sumCache.key && Date.now() - sumCache.t < TTL) return sumCache.val;
  const out = {}; const seen = new Set();
  for (const p of projects || []) {
    if (!p || !p.path || seen.has(p.path)) continue;   // same folder listed twice: count once
    seen.add(p.path);
    const list = listTopics(p.path).map(t => topicSummary(p.path, t)).filter(Boolean);
    if (list.length) out[p.id] = list.sort((a, b) => b.mtime - a.mtime || a.topic.localeCompare(b.topic));
  }
  sumCache = { t: Date.now(), key, val: out };
  return out;
}

function topicDir(projectPath, topic) {
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic) || topic === '.' || topic === '..') return null;
  const dir = path.join(projectPath, 'docs', topic);
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  if (!inDocs(projectPath, dir)) return null;
  return dir;
}

function otherFiles(root, dir) {
  const out = [];
  const add = (sub) => {
    let ents; try { ents = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = sub ? sub + '/' + e.name : e.name;
      if (e.isFile() && /\.md$/i.test(e.name) && inDocs(root, path.join(dir, rel)) && !(sub === '' && /^(PLAN|PROGRESS)\.md$/.test(e.name))) out.push(rel);
      else if (!sub && e.isDirectory() && !e.name.startsWith('.') && inDocs(root, path.join(dir, rel))) add(e.name);
    }
  };
  add('');
  return out.sort();
}

function detail(projectPath, topic) {
  const dir = topicDir(projectPath, topic);
  if (!dir) return { error: 'no such plan' };
  const pr = readIn(projectPath, path.join(dir, 'PROGRESS.md'));
  const pl = readIn(projectPath, path.join(dir, 'PLAN.md'));
  if (!pr && !pl) return { error: 'no such plan' };
  let progress = null;
  if (pr) { const p = progressOf(pr); progress = { text: pr.text.slice(0, MAX_FILE), done: p.done, total: p.total, items: p.items }; }
  return {
    topic, progress, plan: pl ? { text: pl.text.slice(0, MAX_FILE) } : null, files: otherFiles(projectPath, dir),
    mtime: Math.round(Math.max(pr ? pr.mtimeMs : 0, pl ? pl.mtimeMs : 0)),
  };
}

function file(projectPath, topic, rel) {
  const dir = topicDir(projectPath, topic);
  if (!dir) return { error: 'no such plan' };
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel)) return { error: 'bad path' };
  if (rel.split('/').some(s => s === '..' || s === '')) return { error: 'bad path' };
  if (!/\.md$/i.test(rel)) return { error: 'only .md files' };
  const fp = path.join(dir, rel);
  if (!fp.startsWith(dir + path.sep)) return { error: 'bad path' };
  let real; try { real = fs.realpathSync(fp); } catch { return { error: 'no such file' }; }
  let realDir; try { realDir = fs.realpathSync(dir); } catch { return { error: 'no such file' }; }
  if (!real.startsWith(realDir + path.sep)) return { error: 'bad path' };
  let st; try { st = fs.statSync(real); } catch { return { error: 'no such file' }; }
  if (!st.isFile()) return { error: 'no such file' };
  if (st.size > MAX_FILE) return { error: 'file too large (max 400 KB)' };
  try { return { text: fs.readFileSync(real, 'utf8') }; } catch { return { error: 'unreadable' }; }
}

module.exports = { summary, detail, file };
