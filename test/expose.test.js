const test = require('node:test');
const assert = require('node:assert');
const expose = require('../lib/expose');
const { plan } = expose;

const IP = '100.64.0.1';
const port = (port, proc, addr = '127.0.0.1') => ({ port, proc, addr, pid: port * 10, loopback: addr === '127.0.0.1' || addr === '::1', wildcard: false });
function snap({ ports, exposures = [] }) {
  return { ports, sessions: [{ project: 'app', ports: ports.filter(p => p.loopback) }], external: [], containers: [{ state: 'running', project: 'app', ports: [{ host: 11211, hostIp: '127.0.0.1' }] }], exposures };
}
const none = new Map();
const fwd = (port, pid) => ({ port, pid, bind: IP, target: '127.0.0.1:' + port });

test('a dev server is forwarded; databases, caches and Chrome debug ports are not', () => {
  const s = snap({ ports: [port(5173, 'node'), port(5432, 'postgres'), port(5433, 'docker-proxy'), port(11211, 'docker-proxy'), port(9371, 'headless_shell'), port(6400, 'redis-server')] });
  assert.deepStrictEqual(plan(s, IP, { auto: true, manualPorts: none, deny: [] }).spawn, [[5173, '127.0.0.1']]);
});

test('ports in exposeDeny are not auto-forwarded and their running forward is stopped', () => {
  const s = snap({ ports: [port(5173, 'node'), port(3003, 'node')], exposures: [fwd(3003, 77)] });
  const r = plan(s, IP, { auto: true, manualPorts: none, deny: [3003] });
  assert.deepStrictEqual(r.spawn, [[5173, '127.0.0.1']]);
  assert.deepStrictEqual(r.kill, [77]);
});

test('turning auto off stops every auto forward but keeps manual ones', () => {
  const s = snap({ ports: [port(5173, 'node'), port(8000, 'python3')], exposures: [fwd(5173, 1), fwd(8000, 2)] });
  const r = plan(s, IP, { auto: false, manualPorts: new Map([[8000, '127.0.0.1']]), deny: [] });
  assert.deepStrictEqual(r, { spawn: [], kill: [1] });
});

test('a manual forward of a denied port is honoured', () => {
  const s = snap({ ports: [port(5432, 'postgres')] });
  assert.deepStrictEqual(plan(s, IP, { auto: true, manualPorts: new Map([[5432, '127.0.0.1']]), deny: [] }).spawn, [[5432, '127.0.0.1']]);
});

test('an auto forward whose target stopped listening is dropped', () => {
  const s = snap({ ports: [], exposures: [fwd(5173, 9)] });
  assert.deepStrictEqual(plan(s, IP, { auto: true, manualPorts: none, deny: [] }).kill, [9]);
});

test('socat forwards the dashboard did not start are left alone', () => {
  const s = snap({ ports: [port(5173, 'node')], exposures: [{ port: 5433, pid: 5, bind: '127.0.0.1', target: '10.0.0.9:5432' }, { port: 7000, pid: 6, bind: IP, target: '10.0.0.9:7000' }] });
  assert.deepStrictEqual(plan(s, IP, { auto: false, manualPorts: none, deny: [] }).kill, []);
});

test('debugger ports are never auto-exposed and inspector flags are recognised', () => {
  assert.deepStrictEqual(expose.debugPorts('node --inspect server.js'), [9229]);
  assert.deepStrictEqual(expose.debugPorts('node --inspect-brk=127.0.0.1:9333 app.js'), [9333]);
  assert.deepStrictEqual(expose.debugPorts('chrome --remote-debugging-port=9555'), [9555]);
  assert.deepStrictEqual(expose.debugPorts('node server.js'), []);
});

test('ours without an ip accepts only tailnet binds forwarding to the same loopback port', () => {
  assert.ok(expose.ours({ port: 3000, bind: '100.64.1.2', target: '127.0.0.1:3000' }, null));
  assert.ok(!expose.ours({ port: 5433, bind: '127.0.0.1', target: '10.0.0.9:5432' }, null));
  assert.ok(!expose.ours({ port: 3000, bind: '192.168.1.5', target: '127.0.0.1:3000' }, null));
});

test('the Node inspector port is not auto-forwarded and a bad exposeDeny value is ignored', () => {
  const s = snap({ ports: [port(5173, 'node'), port(9229, 'node')] });
  assert.deepStrictEqual(plan(s, IP, { auto: true, manualPorts: none, deny: 42 }).spawn, [[5173, '127.0.0.1']]);
});
