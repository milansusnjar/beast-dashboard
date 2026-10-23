'use strict';
const fs = require('fs');
const { run } = require('./util');

const HELPERS = { 'tmux: server': 'tmux-server', socat: 'socat', adb: 'adb' };
const RETRY_MS = 10 * 60e3;

const ownCgroup = (() => {
  try { const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(l => l.startsWith('0::')); return line ? line.slice(3).trim() : null; } catch { return null; }
})();
const tried = new Map();

function members() {
  try { return fs.readFileSync(`/sys/fs/cgroup${ownCgroup}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
}
function comm(pid) { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } }

async function detachHelpers() {
  if (!ownCgroup || !ownCgroup.endsWith('.service')) return;
  const now = Date.now();
  for (const pid of members()) {
    if (pid === process.pid) continue;
    const name = HELPERS[comm(pid)]; if (!name) continue;
    if (now - (tried.get(pid) || 0) < RETRY_MS) continue;
    tried.set(pid, now);
    const unit = `bd-keep-${name}-${pid}.scope`;
    const r = await run('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', unit, 'fail', '3', 'PIDs', 'au', '1', String(pid), 'Description', 's', `${name} started by beast-dash`, 'OOMPolicy', 's', 'continue', '0'], { timeout: 5000 });
    console.log(r.ok ? `detach: ${name} ${pid} -> ${unit}` : `detach: ${name} ${pid} stays in the service (${(r.stderr || '').trim().split('\n')[0]})`);
  }
  for (const pid of tried.keys()) if (now - tried.get(pid) > RETRY_MS && !fs.existsSync(`/proc/${pid}`)) tried.delete(pid);
}

module.exports = { detachHelpers };
