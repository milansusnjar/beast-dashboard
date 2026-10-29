'use strict';
const settings = require('./settings');

const WAKE = new Set(['needs-you', 'permission', 'error', 'limit']);
const BLOCKED = new Set(['permission', 'error', 'limit']);

let store = settings;
function init(o = {}) { if (o.store) store = o.store; }
const all = () => store.get().settled || {};
function write(map) { store.update({ settled: map }); }

function of(name, now = Date.now()) {
  const e = all()[name];
  if (!e) return null;
  if (e.until && e.until <= now) return null;
  return e;
}

function set(name, until, now = Date.now()) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name || '')) return { ok: false, error: 'bad session name' };
  const map = { ...all() };
  if (until === false) delete map[name];
  else if (until === null || until === undefined) map[name] = { at: now, until: null };
  else {
    const t = Number(until);
    if (!Number.isFinite(t) || t <= now || t > now + 7 * 86400e3) return { ok: false, error: 'snooze time must be within the next 7 days' };
    map[name] = { at: now, until: Math.round(t) };
  }
  write(map);
  return { ok: true, settled: map[name] || null };
}

function wake(name, state, since = null) {
  const e = all()[name];
  if (!e) return false;
  if (since != null && !(since > e.at)) return false;
  if (!(e.until ? BLOCKED.has(state) : WAKE.has(state))) return false;
  const map = { ...all() }; delete map[name]; write(map);
  return true;
}

const onChange = (ev, r) => wake(r.tmux, r.state);

function expire(now = Date.now(), alive = null) {
  const map = all(); let changed = false; const next = {};
  for (const [k, e] of Object.entries(map)) {
    if ((e.until && e.until <= now) || (alive && !alive.has(k))) { changed = true; continue; }
    next[k] = e;
  }
  if (changed) write(next);
  return changed;
}

const quiet = (name, now = Date.now()) => !!of(name, now);

module.exports = { init, of, set, onChange, wake, expire, quiet, WAKE };
