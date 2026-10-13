'use strict';
// Read the tail of a Claude Code transcript (<config>/projects/<cwd>/<session>.jsonl) as a list of turns for the
// dashboard: your prompts, Claude's text, and the tool calls in between (collapsed to one line each).
const fs = require('fs');
const { describeTool } = require('./claude');

const TAIL = 3 * 1024 * 1024;   // read at most the last 3 MB — enough for dozens of turns even with big tool results
const trim = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
}

// What a `type:"user"` record really is. Claude Code writes much more than your prompts as user records: background
// agent / command completions (origin.kind "task-notification", <task-notification> payload), "[Request interrupted
// by user]", `!` shell commands and their output, slash commands, pasted-content wrappers, system reminders.
// Only origin.kind "human" (or, in older versions without origin, plain text) is something you typed.
//   -> { kind: 'prompt' | 'event' | 'shell' | 'shell-out' | 'skip', text, status }
const tag = (t, name) => { const m = t.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>')); return m ? m[1].trim() : ''; };
function classifyUser(o, raw) {
  let t = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const origin = o.origin && o.origin.kind;
  if (origin === 'task-notification' || t.startsWith('<task-notification>')) {
    const status = tag(t, 'status'); const summary = tag(t, 'summary') || tag(t, 'description') || 'background task finished';
    return { kind: 'event', text: summary.replace(/\s+/g, ' '), status: status || null };
  }
  if (/^\[Request interrupted by user/.test(t)) return { kind: 'event', text: 'interrupted', status: 'interrupted' };
  if (t.startsWith('<bash-input>')) return { kind: 'shell', text: tag(t, 'bash-input') };
  if (t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) return { kind: 'shell-out', text: (tag(t, 'bash-stdout') + '\n' + tag(t, 'bash-stderr')).trim() };
  if (/^<local-command-caveat>|^<local-command-stdout>/.test(t)) return { kind: 'skip' };
  if (t.startsWith('<command-name>') || (t.startsWith('<command-message>') && t.includes('<command-name>'))) { const c = tag(t, 'command-name'); const a = tag(t, 'command-args'); return c ? { kind: 'prompt', text: (c + (a ? ' ' + a : '')).trim() } : { kind: 'skip' }; }
  t = t.replace(/<\/?pasted_content[^>]*>/g, '').trim();
  if (!t) return { kind: 'skip' };
  if (origin && origin !== 'human') return { kind: 'event', text: t.replace(/\s+/g, ' ').slice(0, 300), status: origin };   // some other synthetic input
  if (t.startsWith('<') && !origin) return { kind: 'skip' };                                                                  // unknown wrapper, older versions
  return { kind: 'prompt', text: t };
}

// Returns { turns, total, size, mtime, pending } with the LAST `n` turns.
// role: 'user' (you typed it), 'assistant', 'event' (a background agent finished, you interrupted, context compacted…),
// 'shell' (`!cmd`). An assistant turn is everything Claude did for one prompt, IN ORDER:
//   steps: [{ k: 'text', text } | { k: 'tool', id, name, what, done, error, …summary }], dur (ms, from turn_duration)
// Tool steps carry only a short summary; the full input/output of one call comes from tool() when it's opened, so
// the chat can poll this cheaply.
const base = p => String(p || '').split('/').pop();
const lines1 = s => (String(s || '').match(/\n/g) || []).length + (s ? 1 : 0);
function patchStats(sp) { let add = 0, del = 0; for (const hk of Array.isArray(sp) ? sp : []) for (const l of hk.lines || []) { if (l[0] === '+') add++; else if (l[0] === '-') del++; } return { add, del }; }
function toolSummary(b) {
  const inp = b.input || {}; const t = { k: 'tool', id: b.id, name: b.name, what: describeTool(b.name, inp), done: false };
  switch (b.name) {
    case 'Bash': case 'PowerShell': t.desc = trim(inp.description || '', 120); t.cmd = trim(inp.command, 240); if (inp.run_in_background) t.bg = true; break;
    case 'Read': t.file = inp.file_path; break;
    case 'Edit': t.file = inp.file_path; t.add = lines1(inp.new_string); t.del = lines1(inp.old_string); break;
    case 'MultiEdit': t.file = inp.file_path; break;
    case 'Write': t.file = inp.file_path; t.add = lines1(inp.content); break;
    case 'NotebookEdit': t.file = inp.notebook_path; break;
    case 'Grep': case 'Glob': t.pattern = trim(inp.pattern, 120); t.path = inp.path || ''; break;
    case 'Agent': case 'Task': t.desc = trim(inp.description || '', 120); t.sub = inp.subagent_type || ''; if (inp.run_in_background) t.bg = true; break;
    case 'WebSearch': t.query = trim(inp.query, 200); break;
    case 'WebFetch': t.url = trim(inp.url, 300); break;
    case 'AskUserQuestion': t.qs = (inp.questions || []).map(q => trim(q.question, 200)); t.qFull = (inp.questions || []).map(q => q.question); break;
    case 'TodoWrite': t.todos = (inp.todos || []).slice(0, 30).map(x => ({ c: trim(x.content || x.activeForm, 140), s: x.status })); break;
  }
  return t;
}
// fold a tool_result (+ the record's toolUseResult) into its tool step
function toolDone(t, b, tur) {
  t.done = true; t.error = !!b.is_error;
  if (!tur || typeof tur !== 'object') return;
  if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) Object.assign(t, patchStats(tur.structuredPatch));
  if (tur.type === 'create') t.created = true;
  if (tur.file && tur.file.numLines) t.lines = tur.file.numLines;
  if (tur.type === 'image') t.image = true;
  if (t.name === 'Bash' && tur.interrupted) t.error = true;
  if (t.name === 'AskUserQuestion' && tur.answers) t.answers = (t.qFull || []).map(q => trim(tur.answers[q] || '', 200));
  if ((t.name === 'Agent' || t.name === 'Task') && tur.isAsync) t.bg = true;
  if (typeof tur.numFiles === 'number') t.count = tur.numFiles; else if (typeof tur.numLines === 'number' && t.name === 'Grep') t.count = tur.numLines;
}

function readTail(file, max = TAIL) {
  let st; try { st = fs.statSync(file); } catch (e) { return null; }
  const len = Math.min(st.size, max); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n'); if (st.size > max) lines.shift();   // first line is a fragment
  return { st, lines };
}

function tail(file, n = 40) {
  // A fresh session: SessionStart already gave us the path, but Claude Code writes the file only with the first
  // message -> an empty conversation (the chat opens and you can type the first prompt there), not an error.
  const rt = readTail(file); if (!rt) return { total: 0, turns: [], size: 0, mtime: 0, pending: null, empty: true }; const { st, lines } = rt;
  const turns = []; let cur = null; const byId = new Map();
  const push = t => { turns.push(t); cur = null; };
  for (const line of lines) {
    if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('"subtype":"turn_duration"') || line.includes('"subtype":"compact_boundary"'))) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;                                   // subagent traffic
    const ts = o.timestamp ? Date.parse(o.timestamp) : null; const m = o.message || {};
    if (o.type === 'system') {
      if (o.subtype === 'turn_duration') { const last = turns[turns.length - 1]; if (last && last.role === 'assistant' && o.durationMs) last.dur = +o.durationMs; }
      else if (o.subtype === 'compact_boundary') push({ role: 'event', ts, text: 'context compacted' + (o.compactMetadata?.trigger === 'auto' ? ' (auto)' : ''), status: 'compacted' });
      continue;
    }
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) continue;              // the compaction summary itself: the boundary event stands for it
      const c = m.content;
      // tool results come back as user messages: fold them into their tool step
      if (Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result')) {
        for (const b of c) { const t = byId.get(b.tool_use_id); if (t) toolDone(t, b, c.length === 1 ? o.toolUseResult : null); }
        continue;
      }
      const k = classifyUser(o, textOf(c));
      if (k.kind === 'skip') continue;
      if (k.kind === 'event') { push({ role: 'event', ts, text: trim(k.text, 400), status: k.status }); continue; }
      if (k.kind === 'shell') { push({ role: 'shell', ts, text: trim(k.text, 400), out: '' }); continue; }
      if (k.kind === 'shell-out') { const last = turns[turns.length - 1]; if (last && last.role === 'shell') last.out = trim(k.text, 2000); continue; }
      push({ role: 'user', ts, text: trim(k.text, 4000) });
    } else if (o.type === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (!blocks.some(b => (b.type === 'text' && b.text && b.text.trim()) || b.type === 'tool_use')) continue;   // thinking only (stored without text)
      // everything Claude does for one prompt (streamed lines, tool rounds) is one turn, in order
      const last = turns[turns.length - 1];
      if (!cur && last && last.role === 'assistant') cur = last;
      if (!cur) { cur = { role: 'assistant', ts, steps: [] }; turns.push(cur); }
      for (const b of blocks) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          const prev = cur.steps[cur.steps.length - 1];
          if (prev && prev.k === 'text') { if (prev.text.length < 12000) prev.text = trim(prev.text + '\n\n' + b.text, 12000); } else cur.steps.push({ k: 'text', text: trim(b.text, 12000) });
        } else if (b.type === 'tool_use' && !byId.has(b.id)) { const t = toolSummary(b); byId.set(b.id, t); cur.steps.push(t); }
      }
    }
  }
  // a tool call still waiting for its result at the end of the transcript = Claude is executing it right now (an
  // independent "working" signal for the chat, next to hooks and the pane). Only while the file is fresh, so a call
  // that never got its result (crash, killed session) doesn't spin forever.
  const lastT = turns[turns.length - 1];
  const running = lastT && lastT.role === 'assistant' ? lastT.steps.filter(x => x.k === 'tool' && !x.done) : [];
  const fresh = Date.now() - st.mtimeMs < 30 * 60e3;
  if (!fresh) for (const x of running) x.stale = true;
  for (const t of turns) if (t !== lastT && t.steps) for (const x of t.steps) if (x.k === 'tool' && !x.done) x.stale = true;   // never got its result (crash, resume)
  for (const t of turns) for (const x of t.steps || []) delete x.qFull;
  const pending = running.length && fresh ? running[running.length - 1].what || running[running.length - 1].name : null;
  return { total: turns.length, turns: turns.slice(-n), size: st.size, mtime: st.mtimeMs, pending };
}
// text of an assistant turn (handoff, notifications): its text steps joined
const turnText = t => (t.steps || []).filter(x => x.k === 'text').map(x => x.text).join('\n\n');

// Everything about ONE tool call, for when it's opened in the chat: full command + output, the diff, an agent's
// prompt + answer, or the raw input/result for anything else.
function headTail(s, n) { s = String(s || ''); if (s.length <= n) return s; const k = Math.floor(n / 2); return s.slice(0, k) + `\n\n… ${s.length - n} characters left out …\n\n` + s.slice(-k); }
function tool(file, id) {
  const rt = readTail(file, 32 * 1024 * 1024);   // only on a click: look further back than the chat window (screenshots bloat files) if (!rt) return { error: 'no transcript' };
  let use = null, res = null, tur = null;
  for (const line of rt.lines) {
    if (!line.includes(id)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    for (const b of (o.message && Array.isArray(o.message.content) ? o.message.content : [])) {
      if (b.type === 'tool_use' && b.id === id) use = b;
      if (b.type === 'tool_result' && b.tool_use_id === id) { res = b; tur = o.message.content.length === 1 ? o.toolUseResult : null; }
    }
  }
  if (!use) return { error: 'tool call not found' };
  const inp = use.input || {}; const out = { id, name: use.name, done: !!res, error: !!(res && res.is_error) };
  const resText = res ? textOf(res.content) : '';
  switch (use.name) {
    case 'Bash': case 'PowerShell':
      out.cmd = trim(inp.command, 6000); out.desc = inp.description || '';
      { const so = tur && typeof tur === 'object' ? [tur.stdout, tur.stderr].filter(Boolean).join('\n').trim() : ''; out.out = headTail(so || resText, 12000); } break;   // background / timed-out: the message is only in the result text
    case 'Edit': case 'Write': case 'MultiEdit': {
      out.file = inp.file_path; const sp = tur && Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null;
      if (sp && sp.length) { let n = 0; out.hunks = []; for (const hk of sp) { if (n >= 600) break; const ls = (hk.lines || []).slice(0, 600 - n); n += ls.length; out.hunks.push({ o: hk.oldStart, n: hk.newStart, lines: ls.map(l => l.length > 400 ? l.slice(0, 400) + '…' : l) }); } out.more = sp.reduce((a, hk) => a + (hk.lines || []).length, 0) > n; }
      else if (use.name === 'Write') out.hunks = [{ o: 0, n: 1, lines: String(inp.content || '').split('\n').slice(0, 600).map(l => '+' + l) }];
      else if (use.name === 'Edit') out.hunks = [{ o: 0, n: 0, lines: [...String(inp.old_string || '').split('\n').map(l => '-' + l), ...String(inp.new_string || '').split('\n').map(l => '+' + l)].slice(0, 600) }];
      if (res && res.is_error) out.out = trim(resText, 2000);
      break; }
    case 'Agent': case 'Task':
      out.desc = inp.description || ''; out.sub = inp.subagent_type || ''; out.prompt = trim(inp.prompt, 8000);
      out.out = tur && tur.isAsync ? 'Running in the background — its answer arrives later as a "finished" line in the chat.' : trim(resText, 20000); break;
    case 'AskUserQuestion':
      out.qa = (inp.questions || []).map(q => ({ q: q.question, a: tur && tur.answers ? tur.answers[q.question] || '' : '', opts: (q.options || []).map(x => x.label) })); break;
    default:
      out.input = trim(JSON.stringify(inp, null, 2), 6000); out.out = headTail(resText, 12000);
      if (res && Array.isArray(res.content) && res.content.some(b => b.type === 'image')) out.image = true;
  }
  return out;
}

module.exports = { tail, tool, turnText, classifyUser };
