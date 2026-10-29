'use strict';
const path = require('path');
const os = require('os');

const GENERIC = new Set(['api', 'app', 'apps', 'web', 'webapp', 'backend', 'frontend', 'mobile', 'ios', 'android', 'infra', 'sdk', 'client', 'server', 'admin', 'panel', 'ui', 'shared', 'services', 'service', 'local', 'new', 'models', 'commons', 'standards', 'e2e', 'usa', 'website', 'websites', 'connect', 'school', 'ops', 'core', 'lib', 'common', 'docs', 'site', 'personal', 'dev', 'test', 'tests', 'react', 'native', 'node', 'python', 'voice', 'gym']);
const SUFFIX = 4, RECENT = 14 * 864e5, ACCOUNT_DAYS = 60 * 864e5, MAX_CANDS = 6;

const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'dj').replace(/Đ/g, 'dj').toLowerCase();
const tokens = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const squash = s => tokens(s).join('');

function textIndex(text) {
  const toks = tokens(text);
  const has = t => toks.some(w => w === t || (t.length >= 4 && w.startsWith(t) && w.length - t.length <= SUFFIX));
  const grams = new Set();
  for (let i = 0; i < toks.length; i++) { let g = ''; for (let j = i; j < Math.min(toks.length, i + 4); j++) { g += toks[j]; grams.add(g); } }
  const hasSquashed = sq => sq.length >= 5 && (grams.has(sq) || [...grams].some(g => g.startsWith(sq) && g.length - sq.length <= SUFFIX));
  return { toks, has, hasSquashed };
}

function pathsIn(text, devRoot, home) {
  const out = [];
  const re = /(~\/[^\s'"`<>()]+|\/home\/[^\s'"`<>()]+|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@-]+)+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let p = m[1].replace(/[.,;:!?]+$/, '');
    if (p.startsWith('~/')) p = path.join(home, p.slice(2));
    if (devRoot && p.startsWith(devRoot + '/')) out.push(path.normalize(p));
  }
  return out;
}

function nameScore(name, idx) {
  const toks = tokens(name);
  const distinct = toks.filter(t => !GENERIC.has(t) && t.length >= 2);
  const hit = toks.filter(t => idx.has(t));
  const full = distinct.length > 0 && (hit.length === toks.length || idx.hasSquashed(squash(name)));
  return { full, toks, distinctToks: distinct, hits: hit.length, part: toks.length ? hit.length / toks.length : 0, distinct: hit.some(t => distinct.includes(t)) };
}

function groupsOf(projects, devRoot) {
  const groups = new Map();
  for (const p of projects) {
    const segs = String(p.rel || '').split('/');
    for (let i = 2; i < segs.length; i++) {
      const rel = segs.slice(0, i).join('/');
      if (!groups.has(rel)) groups.set(rel, { rel, org: segs[0], name: segs[i - 1], cwd: path.join(devRoot, rel), members: [] });
      groups.get(rel).members.push(p.id);
    }
  }
  return groups;
}

function accountHint(history, match, now) {
  const n = { personal: 0, company: 0 };
  for (const e of history || []) {
    if (!e || now - (e.lastAt || 0) > ACCOUNT_DAYS || !n.hasOwnProperty(e.account)) continue;
    if ((e.projects || []).some(match)) n[e.account]++;
  }
  if (!n.personal && !n.company) return undefined;
  return n.company > n.personal ? 'company' : 'personal';
}

function guess(text, opts = {}) {
  const projects = (opts.projects || []).filter(p => p && p.id && p.path && !p.hidden);
  const home = opts.home || os.homedir();
  const devRoot = opts.devRoot || path.join(home, 'dev');
  const history = opts.history || [];
  const now = opts.now || Date.now();
  const idx = textIndex(text);
  const byId = new Map(projects.map(p => [p.id, p]));
  const cands = [];

  const recent = new Map();
  for (const e of history) if (e && now - (e.lastAt || 0) < RECENT) for (const id of (e.projects || []).slice(0, 2)) recent.set(id, (recent.get(id) || 0) + 1);

  const pathHits = new Map();
  for (const p of pathsIn(text, devRoot, home)) {
    let best = null;
    for (const pr of projects) if ((p === pr.path || p.startsWith(pr.path + '/')) && (!best || pr.path.length > best.path.length)) best = pr;
    if (best) pathHits.set(best.id, true);
  }

  const orgs = [...new Set(projects.map(p => p.org).filter(Boolean))];
  const orgHit = new Set(orgs.filter(o => !GENERIC.has(fold(o)) && (idx.has(fold(o)) || idx.hasSquashed(squash(o)))));
  const groups = groupsOf(projects, devRoot);
  const groupHit = new Map();
  for (const g of groups.values()) { const s = nameScore(g.name, idx); if (s.full) groupHit.set(g.rel, s); }

  for (const p of projects) {
    let score = 0; const why = []; let explicit = false;
    if (pathHits.has(p.id)) { score += 20; explicit = true; why.push('path'); }
    const ns = nameScore(p.dirName || p.name, idx);
    const segs = String(p.rel || '').split('/');
    const parents = segs.slice(1, -1);
    const parentHit = parents.some(seg => groupHit.has(segs.slice(0, segs.indexOf(seg) + 1).join('/')));
    if (ns.full) { score += 10 + 1.5 * Math.max(0, ns.hits - 1); explicit = true; why.push('name'); }
    else if (ns.distinct && ns.distinctToks.every(t => idx.has(t)) && !ns.distinctToks.every(t => parents.some(seg => tokens(seg).includes(t)))) { score += 6; why.push('name'); }
    else if (ns.distinct || (parentHit && ns.part > 0)) score += ns.part * 4;
    const pkg = String(p.pkgName || '').replace(/^@[^/]+\//, '');
    const own = squash(pkg) && ![p.dirName, p.org, ...parents].some(x => squash(x) === squash(pkg));
    if (!ns.full && own && nameScore(pkg, idx).full) { score += 8; explicit = true; why.push('package'); }
    if (p.name && p.name !== p.dirName && !ns.full) { const s2 = nameScore(p.name, idx); if (s2.full) { score += 9; explicit = true; why.push('name'); } }
    if (parentHit) { score += 3; why.push('folder'); }
    if (p.org && orgHit.has(p.org)) { score += 2; why.push('org'); }
    if (score <= 0 && opts.context !== p.id) continue;
    if (score > 0) { const r = recent.get(p.id) || 0; if (r) { score += Math.min(1.5, r * 0.3); why.push('recent'); } }
    if (opts.context === p.id) { score += 1.5; why.push('open now'); }
    const extra = tokens(p.dirName).filter(t => !idx.has(t)).length;
    score -= extra * 0.1;
    cands.push({ kind: 'project', id: p.id, org: p.org || undefined, cwd: p.path, name: p.name || p.dirName, score, why: why.join(', '), explicit, named: ns.full ? ns.toks : null });
  }

  for (const [rel, s] of groupHit) {
    const g = groups.get(rel);
    const projectHere = projects.some(p => p.rel === rel);
    if (projectHere) continue;
    let score = 6 + (orgHit.has(g.org) ? 2 : 0);
    const r = g.members.reduce((n, id) => n + (recent.get(id) || 0), 0);
    if (r) score += Math.min(1.5, r * 0.3);
    cands.push({ kind: 'org', org: g.org, group: rel.split('/').slice(1).join('/'), cwd: g.cwd, name: g.name, score, why: 'folder', explicit: s.full });
  }
  for (const o of orgHit) cands.push({ kind: 'org', org: o, cwd: path.join(devRoot, o), name: o, score: 4, why: 'org', explicit: true });

  for (const c of cands) if (c.named && cands.some(o => o !== c && o.named && o.named.length > c.named.length && c.named.every(t => o.named.includes(t)))) c.score -= 4;
  cands.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = cands.slice(0, MAX_CANDS - 1);
  for (const c of top) {
    const match = c.kind === 'project' ? id => id === c.id : c.group ? id => { const p = byId.get(id); return !!p && (p.rel || '').startsWith(`${c.org}/${c.group}/`); } : id => { const p = byId.get(id); return !!p && p.org === c.org; };
    const acc = accountHint(history, match, now);
    if (acc) c.account = acc;
    c.score = Math.round(c.score * 10) / 10;
  }
  const root = { kind: 'root', cwd: devRoot, name: devRoot.startsWith(home + '/') ? '~/' + path.relative(home, devRoot) : devRoot, score: 0, why: 'no project' };
  const best = top[0] || root;
  const second = top[1];
  const confident = best.kind === 'project' && !!best.explicit && (!second || best.score - second.score >= 3);
  const clean = c => { const { explicit, named, ...rest } = c; return rest; };
  return { best: clean(best), confident, cands: [...top.map(clean), root] };
}

module.exports = { guess, tokens, fold };
