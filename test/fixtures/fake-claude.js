#!/usr/bin/env node
'use strict';
const fs = require('fs');

if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR || null, child: process.env.CLAUDE_CODE_CHILD_SESSION || null, other: process.env.CLAUDE_CODE_OTHER || null, window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || null }) + '\n');
if (process.env.FAKE_TOUCH) fs.writeFileSync(process.env.FAKE_TOUCH, 'x');
if (process.env.FAKE_BROKEN) { process.stderr.write('fake: broken build\n'); process.exit(1); }
if (process.env.FAKE_NO_CONV && process.argv.includes('--resume')) { process.stderr.write(`No conversation found with session ID: ${process.argv[process.argv.indexOf('--resume') + 1]}\n`); process.exit(1); }
const sid = process.argv[process.argv.indexOf(process.argv.includes('--resume') ? '--resume' : '--session-id') + 1];
const emit = o => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waiting = new Map(), inbox = [];
let inited = false, aborted = false, busy = Promise.resolve(), n = 0;

const stream = event => emit({ type: 'stream_event', event, parent_tool_use_id: null });
async function say(text) {
  stream({ type: 'message_start', message: { id: 'm' + ++n } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const part of text.match(/.{1,4}/gs) || []) { if (aborted) return; stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }); await sleep(5); }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 990, output_tokens: 20 } }, parent_tool_use_id: null });
}
function tool(id, name, input) { emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null }); }
function toolResult(id, content, isError) { emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isError }] }, parent_tool_use_id: null }); }
function ask(request) { const rid = 'req-' + ++n; emit({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', ...request } }); return new Promise(r => waiting.set(rid, r)); }
function done(subtype = 'success', reason = 'completed') { emit({ type: 'result', subtype, terminal_reason: reason, duration_ms: 1, modelUsage: { 'fake-model': { contextWindow: 1000000 } } }); }

async function turn(text) {
  aborted = false;
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1793275200, unifiedWindows: { five_hour: { utilization: 0.07 }, seven_day: { utilization: 0.3 } } } });
  if (text === '/compact') { emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 5020, post_tokens: 1234 } }); done(); return; }
  if (text === 'crash') { process.stderr.write('boom: fake crash\n'); process.exit(3); }
  if (text === 'slow') {
    await say('Working');
    tool('t1', 'Bash', { command: 'sleep 1', description: 'Wait a bit' });
    for (let i = 0; i < 40 && !aborted && !inbox.length; i++) await sleep(10);
    toolResult('t1', 'ok');
    if (inbox.length) await say(' got: ' + inbox.splice(0).join(', '));
    return aborted ? undefined : done();
  }
  if (text === 'longtool') {
    for (let i = 1; i <= 12; i++) await say(`Step ${i}: a paragraph of progress so the turn is long enough to scroll.\n\n`);
    tool('t1', 'Agent', { description: 'Review S7 chat move', prompt: 'x' });
    for (let i = 0; i < 2500 && !aborted; i++) await sleep(10);
    toolResult('t1', 'ok');
    return aborted ? undefined : done();
  }
  if (text === 'hang') { await say('Thinking'); while (!aborted) await sleep(10); return; }
  if (text === 'stubborn') { await say('Thinking'); for (const end = Date.now() + 8000; Date.now() < end;) await sleep(10); return; }
  if (text === 'ask') {
    const r = await ask({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', requires_user_interaction: true, tool_use_id: 'tq', input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] } });
    if (aborted) return;
    await say(r.behavior === 'allow' ? 'answer: ' + JSON.stringify(r.updatedInput.answers) : 'no answer: ' + r.message);
    return done();
  }
  if (text === 'perm') {
    const r = await ask({ tool_name: 'Write', display_name: 'Write', tool_use_id: 'tw', input: { file_path: '/tmp/x.txt', content: 'hi' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    tool('tw', 'Write', { file_path: '/tmp/x.txt', content: 'hi' });
    toolResult('tw', r.behavior === 'deny' ? r.message : 'written', r.behavior === 'deny');
    await say(r.behavior === 'deny' ? 'denied: ' + r.message : 'written');
    return done();
  }
  await say('Echo: ' + text);
  done();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    const o = JSON.parse(l);
    if (o.type === 'control_response') { const f = waiting.get(o.response.request_id); waiting.delete(o.response.request_id); if (f) f(o.response.response); else if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify({ response: o.response }) + '\n'); continue; }
    if (o.type === 'control_request' && o.request.subtype === 'interrupt') {
      aborted = true;
      for (const [rid, f] of waiting) { waiting.delete(rid); emit({ type: 'control_cancel_request', request_id: rid }); f({ behavior: 'deny', message: 'cancelled' }); }
      emit({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { still_queued: [] } } });
      done('error_during_execution', 'aborted_streaming');
      continue;
    }
    if (o.type === 'control_request' && o.request.subtype === 'initialize') { emit({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { commands: [] } } }); continue; }
    if (o.type !== 'user') continue;
    if (!inited) { inited = true; emit({ type: 'system', subtype: 'init', model: 'fake-model', claude_code_version: process.env.FAKE_VERSION || '9.9.9', capabilities: ['interrupt_receipt_v1'] }); }
    const text = o.message.content;
    if (text === 'hook') { emit({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } }); continue; }
    if (busyNow && !aborted) { inbox.push(text); continue; }
    busyNow = true;
    busy = busy.then(() => { busyNow = true; return turn(text); }).finally(() => { busyNow = false; });
  }
});
let busyNow = false;
process.stdin.on('end', () => busy.then(() => process.exit(0)));
