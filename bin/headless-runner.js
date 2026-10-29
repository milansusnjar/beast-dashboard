#!/usr/bin/env node
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { describeTool } = require('../lib/tooldesc');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const SOCK = arg('sock'), CWD = arg('cwd') || process.cwd(), SID = arg('session-id'), ACCOUNT = arg('account') || 'personal';
let CLAUDE = arg('claude') || 'claude';
const NAME = arg('name') || '';
const FORK = arg('start') === 'fork' ? arg('fork-from') : null;
if (!SOCK || !/^[0-9a-f-]{36}$/.test(SID || '') || !['new', 'resume', 'fork'].includes(arg('start')) || (arg('start') === 'fork' && !/^[0-9a-f-]{36}$/.test(FORK || ''))) {
  process.stderr.write('usage: headless-runner.js --sock <path> --cwd <dir> --session-id <uuid> --start new|resume|fork [--fork-from <uuid>] [--account personal|company] [--claude <bin>] [--name <tmux name>]\n');
  process.exit(2);
}

const MAX_LINE = 4 * 1024 * 1024, MAX_TEXT = 200 * 1024, MAX_SEND = 100000;
const INHERITED = ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID'];
const KEEP = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];

const S = { state: 'starting', since: Date.now(), turn: null, rate: null, ctx: null, model: null, version: null, caps: [], error: null };
const pending = new Map();
const clients = new Set();
let child = null, hasConversation = arg('start') === 'resume', stopping = false, seq = 0, stderrTail = '';
let restarting = false, heard = false, unheard = [], upgradeAfterTurn = false, upgradeTimer = null, sentWhileWorking = false;
const queued = [];

const dim = s => `\x1b[2m${s}\x1b[0m`;
const out = s => { try { process.stdout.write(s); } catch {} };
let midLine = false;
const line = s => { out((midLine ? '\n' : '') + s + '\n'); midLine = false; };
const clean = s => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?|\x1b.?/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '').replace(/(^|\n)(\s*[>❯])/g, '$1 $2');
const clock = () => new Date().toTimeString().slice(0, 8);

function snapshot() {
  return { ev: 'snapshot', v: 1, sessionId: SID, state: S.state, since: S.since, turn: S.turn, pending: [...pending.values()].map(p => p.req),
    rate: S.rate, ctx: S.ctx, model: S.model, version: S.version, claude: CLAUDE, caps: S.caps, error: S.error };
}
function emit(o) { const l = JSON.stringify(o) + '\n'; for (const c of clients) c.write(l); }
function setState(state) { if (S.state === state) return; S.state = state; S.since = Date.now(); emit({ ev: 'state', state, since: S.since }); }

function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (INHERITED.includes(k) || (k.startsWith('CLAUDE_CODE_') && !KEEP.includes(k))) delete env[k];
  if (ACCOUNT === 'company') env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME || '', '.claude-company'); else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const configDir = () => ACCOUNT === 'company' ? path.join(process.env.HOME || '', '.claude-company') : path.join(process.env.HOME || '', '.claude');
const forked = () => fs.existsSync(path.join(configDir(), 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'), SID + '.jsonl'));

function startChild() {
  const fork = FORK && !forked();
  if (FORK && !fork) hasConversation = true;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--dangerously-skip-permissions', ...(fork ? ['--resume', FORK, '--fork-session', '--session-id', SID] : [hasConversation ? '--resume' : '--session-id', SID])];
  line(dim(`[${clock()}] claude ${fork ? 'fork of ' + FORK + ' as' : hasConversation ? 'resume' : 'new session'} ${SID}  (${ACCOUNT}, ${CWD})`));
  stderrTail = ''; heard = false; unheard = []; S.version = null; upgradeAfterTurn = false; sentWhileWorking = false; clearTimeout(upgradeTimer);
  const resumed = hasConversation;
  const p = spawn(CLAUDE, args, { cwd: CWD, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  child = p;
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => {
    if (child !== p) return;
    heard = true; unheard = [];
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onChildLine(l); }
    if (buf.length > MAX_LINE * 4) buf = '';
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-2000); });
  p.stdin.on('error', () => {});
  p.on('error', e => {
    if (child !== p) return;
    if (e.code === 'ENOENT' && CLAUDE !== 'claude') {
      const lost = unheard;
      line(dim(`[${clock()}] ${CLAUDE} is gone, using claude from PATH`));
      CLAUDE = 'claude'; child = null;
      startChild();
      for (const text of lost) send(text, true);
      return;
    }
    S.error = `cannot start ${CLAUDE}: ${e.message}`; ended(p, 'error');
  });
  p.on('exit', (code, sig) => {
    if (child !== p) return;
    if (code && stderrTail.trim()) S.error = clean(stderrTail.trim().split('\n').slice(-3).join(' ')).slice(0, 500);
    if (code && fork && !heard && /no conversation found/i.test(stderrTail)) { S.error = `cannot fork: conversation ${FORK} not found`; ended(p, String(code)); return; }
    if (code && resumed && !heard && /no conversation found/i.test(stderrTail)) {
      const lost = unheard;
      child = null; hasConversation = false;
      line(dim(`[${clock()}] no saved conversation ${SID}, starting it new`));
      startChild();
      for (const text of lost) send(text, true);
      return;
    }
    ended(p, sig || String(code));
  });
  setState(S.turn ? 'working' : 'idle');
}

function ended(p, reason) {
  child = null;
  line(dim(`[${clock()}] claude exited (${reason})`) + (S.error ? '  ' + S.error : ''));
  endTurn('exited', reason);
  setState('exited');
  if (stopping) finish();
}

function endTurn(subtype, reason) {
  if (S.turn) emit({ ev: 'result', subtype, reason, ms: Date.now() - S.turn.startedAt });
  S.turn = null;
  for (const rid of pending.keys()) emit({ ev: 'resolved', rid });
  pending.clear();
}

function setCtx(c) {
  const next = { used: null, window: null, ...S.ctx, ...c };
  if (S.ctx && S.ctx.used === next.used && S.ctx.window === next.window) return;
  S.ctx = next;
  emit({ ev: 'ctx', ctx: S.ctx });
}

function write(o) { if (child) child.stdin.write(JSON.stringify(o) + '\n'); }

function beginTurn() {
  if (S.turn) return;
  S.turn = { startedAt: Date.now(), text: '', tools: [] };
  setState('working');
}

function appendText(t) {
  if (!t) return;
  beginTurn();
  if (S.turn.text.length < MAX_TEXT) S.turn.text += t.slice(0, MAX_TEXT - S.turn.text.length);
  emit({ ev: 'delta', text: t });
  const c = clean(t);
  out(!midLine && /^\s*[>❯]/.test(c) ? ' ' + c : c); midLine = !t.endsWith('\n');
}

function onChildLine(l) {
  let o; try { o = JSON.parse(l); } catch { return; }
  if (o.type === 'stream_event') return onStream(o);
  if (o.type === 'assistant' && !o.parent_tool_use_id) {
    const u = o.message && o.message.usage;
    const used = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : 0;
    if (used) setCtx({ used });
    for (const b of (o.message && o.message.content) || []) {
      if (b.type !== 'tool_use' || !S.turn || S.turn.tools.some(t => t.id === b.id)) continue;
      const t = { id: b.id, name: b.name, what: describeTool(b.name, b.input), done: false, at: Date.now() };
      S.turn.tools.push(t);
      emit({ ev: 'tool', id: t.id, name: t.name, what: t.what, at: t.at });
      line(dim(`  · ${clean(t.what)}`));
    }
    return;
  }
  if (o.type === 'user' && !o.parent_tool_use_id && Array.isArray(o.message && o.message.content)) {
    for (const b of o.message.content) {
      if (b.type !== 'tool_result') continue;
      const t = S.turn && S.turn.tools.find(x => x.id === b.tool_use_id);
      if (t) t.done = true;
      emit({ ev: 'tool-done', id: b.tool_use_id, error: !!b.is_error });
    }
    return;
  }
  if (o.type === 'control_request') return onControl(o);
  if (o.type === 'control_cancel_request') {
    if (pending.delete(o.request_id)) emit({ ev: 'resolved', rid: o.request_id });
    return;
  }
  if (o.type === 'result') {
    const mu = o.modelUsage || {}; const m = mu[S.model] || Object.values(mu).sort((a, b) => (b.contextWindow || 0) - (a.contextWindow || 0))[0];
    if (m && m.contextWindow) setCtx({ window: m.contextWindow });
    const ms = S.turn ? Date.now() - S.turn.startedAt : o.duration_ms || 0;
    S.turn = null;
    for (const rid of pending.keys()) emit({ ev: 'resolved', rid });
    pending.clear();
    line(dim(`[${clock()}] done (${o.subtype}${o.terminal_reason && o.terminal_reason !== 'completed' ? ', ' + o.terminal_reason : ''}, ${Math.round(ms / 100) / 10}s)`));
    emit({ ev: 'result', subtype: o.subtype, reason: o.terminal_reason || null, ms });
    setState('idle');
    const late = sentWhileWorking; sentWhileWorking = false;
    if (upgradeAfterTurn && !late) { clearTimeout(upgradeTimer); upgradeTimer = setTimeout(upgradeIfIdle, 1500); }
    return;
  }
  if (o.type === 'rate_limit_event' && o.rate_limit_info) {
    const r = o.rate_limit_info, w = r.unifiedWindows || {};
    S.rate = { status: r.status || null, fiveHour: w.five_hour ? w.five_hour.utilization : null, sevenDay: w.seven_day ? w.seven_day.utilization : null, resetsAt: r.resetsAt || null };
    emit({ ev: 'rate', rate: S.rate });
    return;
  }
  if (o.type === 'system' && o.subtype === 'compact_boundary') {
    const n = o.compact_metadata && o.compact_metadata.post_tokens;
    if (Number.isFinite(n)) setCtx({ used: n });
    return;
  }
  if (o.type === 'system' && o.subtype === 'init') {
    S.model = o.model || null; S.version = o.claude_code_version || null; S.caps = Array.isArray(o.capabilities) ? o.capabilities : [];
    S.error = S.caps.includes('interrupt_receipt_v1') ? null : `claude ${S.version || '?'} may not support the headless control protocol (no interrupt_receipt_v1)`;
    emit(snapshot());
  }
}

function onStream(o) {
  if (o.parent_tool_use_id) return;
  const e = o.event || {};
  if (e.type === 'message_start') return beginTurn();
  if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text') {
    beginTurn();
    if (S.turn.text) { S.turn.text += '\n\n'; emit({ ev: 'block' }); line(''); }
    return;
  }
  if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') appendText(e.delta.text);
}

function onControl(o) {
  const r = o.request || {};
  if (r.subtype !== 'can_use_tool') {
    write({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: `beast-dash runner does not handle ${r.subtype}` } });
    return;
  }
  beginTurn();
  const input = r.input || {};
  const question = r.tool_name === 'AskUserQuestion' || r.requires_user_interaction === true;
  const req = { rid: o.request_id, kind: question ? 'question' : 'permission', tool: r.tool_name, what: describeTool(r.tool_name, input), input,
    questions: question && Array.isArray(input.questions) ? input.questions : undefined,
    suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : undefined, at: Date.now() };
  pending.set(o.request_id, { req, input });
  emit({ ev: 'pending', req });
  if (question) for (const q of req.questions || []) line(clean(`? ${q.question}  [${(q.options || []).map(x => x.label).join(' | ')}]`));
  else line(clean(`? allow ${req.what}`));
}

function respond(rid, response) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: rid, response } });
  pending.delete(rid);
  emit({ ev: 'resolved', rid });
}

function interrupt() {
  if (!child || S.state !== 'working') return;
  for (const rid of [...pending.keys()]) respond(rid, { behavior: 'deny', message: 'Interrupted by user' });
  write({ type: 'control_request', request_id: `int-${++seq}`, request: { subtype: 'interrupt' } });
  line(dim(`[${clock()}] interrupt`));
}

function send(text, again) {
  if (restarting) { queued.push(text); beginTurn(); return; }
  if (!child) startChild();
  const injected = S.state === 'working' && !again;
  if (injected) sentWhileWorking = true;
  write({ type: 'user', message: { role: 'user', content: text } });
  if (!heard) unheard.push(text);
  hasConversation = true;
  if (!again) line(clean(`${injected ? 'you (while working)' : 'you'}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`));
  beginTurn();
}

function restart() {
  if (restarting) return;
  if (!child) { startChild(); return; }
  const old = child;
  child = null; restarting = true;
  endTurn('restarted', 'restart');
  let done = false;
  const respawn = () => {
    if (done) return;
    done = true; restarting = false;
    if (stopping) return finish();
    startChild();
    for (const text of queued.splice(0)) send(text);
  };
  old.on('exit', respawn);
  old.on('error', respawn);
  try { old.stdin.end(); } catch {}
  old.kill('SIGTERM');
  setTimeout(() => { try { old.kill('SIGKILL'); } catch {} }, 3000).unref();
}

function quiet() { return child && !restarting && S.state === 'idle' && !S.turn && !pending.size; }
function upgradeIfIdle() {
  upgradeTimer = null;
  if (!upgradeAfterTurn || !quiet()) return;
  upgradeAfterTurn = false;
  line(dim(`[${clock()}] restarting on ${CLAUDE}`));
  restart();
}
function upgrade(bin) {
  CLAUDE = bin;
  emit(snapshot());
  if (restarting) { upgradeAfterTurn = false; return 'now'; }
  if (!child) { upgradeAfterTurn = false; return 'next-start'; }
  if (!quiet()) { upgradeAfterTurn = true; return 'after-turn'; }
  upgradeAfterTurn = true; upgradeIfIdle();
  return 'now';
}
const executable = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

function onClientOp(c, m) {
  const ack = () => c.write(JSON.stringify({ ev: 'ack', cid: m.cid }) + '\n');
  const fail = error => c.write(JSON.stringify({ ev: 'error', cid: m.cid, error }) + '\n');
  switch (m.op) {
    case 'hello': c.write(JSON.stringify(snapshot()) + '\n'); return;
    case 'send': {
      if (stopping) return fail('runner is stopping');
      const text = typeof m.text === 'string' ? m.text : '';
      if (!text.trim() || text.length > MAX_SEND) return fail('text must be 1..100000 chars');
      send(text); return ack();
    }
    case 'interrupt': interrupt(); return ack();
    case 'answer': {
      const p = pending.get(m.rid);
      if (!p) return fail('no such request');
      if (m.decision === 'deny') respond(m.rid, { behavior: 'deny', message: typeof m.message === 'string' && m.message ? m.message.slice(0, 2000) : 'The user declined this.' });
      else if (m.decision !== 'allow') return fail('decision must be allow or deny');
      else if (p.req.kind === 'question') {
        const answers = {};
        for (const [k, v] of Object.entries(m.answers && typeof m.answers === 'object' ? m.answers : {})) answers[String(k)] = String(v).slice(0, 2000);
        respond(m.rid, { behavior: 'allow', updatedInput: { ...p.input, answers } });
        line(dim(`  → ${Object.values(answers).join(', ')}`));
      } else respond(m.rid, { behavior: 'allow', updatedInput: p.input });
      return ack();
    }
    case 'restart': restart(); return ack();
    case 'upgrade': {
      if (typeof m.claude !== 'string' || !path.isAbsolute(m.claude) || !executable(m.claude)) return fail('claude must be an absolute path to an executable file');
      return c.write(JSON.stringify({ ev: 'ack', cid: m.cid, when: upgrade(m.claude) }) + '\n');
    }
    default: return fail('unknown op');
  }
}

let sockIno = 0;
function serve() {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch {}
  const server = net.createServer(c => {
    clients.add(c);
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', d => {
      buf += d;
      if (buf.length > MAX_LINE) { c.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        let m; try { m = JSON.parse(l); } catch { c.write(JSON.stringify({ ev: 'error', error: 'bad json' }) + '\n'); continue; }
        if (m && typeof m === 'object') onClientOp(c, m);
      }
    });
    c.on('error', () => {});
    c.on('close', () => clients.delete(c));
  });
  const mask = process.umask(0o077);
  try { server.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); sockIno = fs.statSync(SOCK).ino; } catch {} }); } finally { process.umask(mask); }
  server.on('error', e => { line(`socket ${SOCK}: ${e.message}`); process.exit(1); });
}
function keepSocket() {
  if (stopping || !sockIno || fs.existsSync(SOCK)) return;
  line(dim(`[${clock()}] socket was removed — listening again`));
  sockIno = 0; try { serve(); } catch (e) { line(`socket ${SOCK}: ${e.message}`); }
}
setInterval(keepSocket, 1000);

function finish() { try { if (fs.statSync(SOCK).ino === sockIno) fs.unlinkSync(SOCK); } catch {} process.exit(0); }
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (!child) return restarting ? undefined : finish();
  interrupt();
  try { child.stdin.end(); } catch {}
  const c = child;
  setTimeout(() => { try { c.kill('SIGTERM'); } catch {} }, 3000).unref();
  setTimeout(() => { try { c.kill('SIGKILL'); } catch {} finish(); }, 6000).unref();
}
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, shutdown);

function readOnlyPane() {
  if (!process.stdin.isTTY) return;
  let hinted = 0;
  try { process.stdin.setRawMode(true); } catch { return; }
  process.stdin.on('data', () => { const now = Date.now(); if (now - hinted > 10000) { hinted = now; line(dim('(this pane is only a log — type in the dashboard chat)')); } });
  process.stdin.on('error', () => {});
  process.stdin.resume();
}

line(dim(`beast-dash chat session ${NAME}  — type in the dashboard chat, this pane only shows a log`));
readOnlyPane();
serve();
startChild();
