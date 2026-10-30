const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-follow-')));
process.env.BD_TEST = '1';
process.env.BD_MIRROR = tmp;
process.env.XDG_RUNTIME_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'claude-sessions.json'), '{}');
const claude = require('../lib/claude');
const headless = require('../lib/headless');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OLD = '11111111-2222-4333-8444-555555555555', NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', FORK = '99999999-8888-4777-8666-555555555555';
const RUNNER = path.join(__dirname, '..', 'bin', 'headless-runner.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

function folder(name) {
  const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true });
  const file = id => path.join(d, id + '.jsonl');
  const write = (id, ageMs) => { fs.writeFileSync(file(id), '{}\n'); const t = new Date(Date.now() - ageMs); fs.utimesSync(file(id), t, t); return file(id); };
  return { d, file, write };
}
function chatRec(name, f) { claude.all()[name] = { tmux: name, mode: 'chat', account: 'personal', cwd: tmp, state: 'idle', ...f }; return claude.get(name); }

test('conversationOf: a chat moved on by /clear continues the conversation its transcript shows, not the id it started with', () => {
  const f = folder('a');
  f.write(OLD, 60000); f.write(NEW, 1000);
  assert.strictEqual(claude.conversationOf({ mode: 'chat', sessionId: OLD, transcriptPath: f.file(NEW) }), NEW);
  assert.strictEqual(claude.conversationOf({ mode: 'chat', sessionId: OLD, transcriptPath: f.file(OLD) }), OLD);
  assert.strictEqual(claude.conversationOf({ sessionId: OLD, transcriptPath: f.file(NEW) }), OLD);
  assert.strictEqual(claude.conversationOf(null), null);
});

test('conversationOf: an older or missing transcript file does not replace the session id', () => {
  const f = folder('b');
  f.write(OLD, 1000); f.write(NEW, 60000);
  assert.strictEqual(claude.conversationOf({ mode: 'chat', sessionId: OLD, transcriptPath: f.file(NEW) }), OLD);
  assert.strictEqual(claude.conversationOf({ mode: 'chat', sessionId: OLD, transcriptPath: f.file(FORK) }), OLD);
  assert.strictEqual(claude.conversationOf({ mode: 'chat', sessionId: OLD, transcriptPath: path.join(f.d, 'notes.jsonl') }), OLD);
  const g = folder('c'); g.write(NEW, 1000);
  assert.strictEqual(claude.conversationOf({ mode: 'chat', sessionId: OLD, transcriptPath: g.file(NEW) }), NEW);
});

test('followChat: the record takes the runner\'s conversation id and transcript, drops forkFrom; terminals and bad ids are ignored', () => {
  const f = folder('d');
  chatRec('claude-chat-a', { sessionId: OLD, forkFrom: FORK, transcriptPath: f.file(OLD), pastTranscripts: [] });
  assert.strictEqual(claude.followChat('claude-chat-a', NEW), true);
  const r = claude.get('claude-chat-a');
  assert.strictEqual(r.sessionId, NEW); assert.strictEqual(r.forkFrom, null);
  assert.strictEqual(r.transcriptPath, f.file(NEW)); assert.deepStrictEqual(r.pastTranscripts, [f.file(OLD)]);
  assert.strictEqual(claude.followChat('claude-chat-a', NEW), false);
  assert.strictEqual(claude.followChat('claude-chat-a', 'nope'), false);
  claude.all()['claude-term'] = { tmux: 'claude-term', sessionId: OLD, transcriptPath: f.file(OLD) };
  assert.strictEqual(claude.followChat('claude-term', NEW), false);
  assert.strictEqual(claude.get('claude-term').sessionId, OLD);
  assert.strictEqual(claude.followChat('claude-missing', NEW), false);
});

test('liveVersion: the runner\'s version, else the version in its binary path, else claude on PATH', () => {
  assert.strictEqual(headless.liveVersion({ version: '2.1.314', claude: 'claude' }, '2.1.300'), '2.1.314');
  assert.strictEqual(headless.liveVersion({ version: null, claude: '/home/u/.local/share/claude/versions/2.1.314' }, '2.1.300'), '2.1.314');
  assert.strictEqual(headless.liveVersion({ version: null, claude: 'claude' }, '2.1.314'), '2.1.314');
  assert.strictEqual(headless.liveVersion({ version: null, claude: '/usr/bin/claude' }, '2.1.314'), null);
  assert.strictEqual(headless.liveVersion({ version: null, claude: 'claude' }, null), null);
  assert.strictEqual(headless.liveVersion({ version: '2.1.314', stale: true }, '2.1.314'), null);
  assert.strictEqual(headless.liveVersion(null, '2.1.314'), null);
});

test('restartChat: after /clear the restart resumes the conversation the chat is on, waits for the new claude and reports its version', async t => {
  headless.init({ port: 8797, test: true });
  const name = 'claude-chat-follow', dir = folder('run').d, argsLog = path.join(dir, 'args.jsonl');
  const bin = path.join(dir, '4.5.6');
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  const p = spawn(process.execPath, [RUNNER, '--sock', headless.sockPath(name), '--cwd', dir, '--session-id', OLD, '--start', 'new', '--claude', FAKE, '--name', name],
    { env: { ...process.env, FAKE_ARGS: argsLog, FAKE_CLEAR_ID: NEW }, stdio: 'ignore' });
  t.after(() => { headless.forget(name); try { p.kill('SIGKILL'); } catch {} });
  for (let i = 0; i < 100 && !fs.existsSync(headless.sockPath(name)); i++) await new Promise(r => setTimeout(r, 20));
  const rec = chatRec(name, { sessionId: OLD, transcriptPath: path.join(dir, OLD + '.jsonl') });
  const idle = async () => { for (let i = 0; i < 200 && !((await headless.status(name)) || {}).state?.startsWith('idle'); i++) await new Promise(r => setTimeout(r, 20)); };
  await idle();
  assert.strictEqual((await headless.send(name, 'hello')).ok, true);
  await new Promise(r => setTimeout(r, 100)); await idle();
  assert.strictEqual((await headless.send(name, '/clear')).ok, true);
  for (let i = 0; i < 200 && (headless.live(name) || {}).sessionId !== NEW; i++) await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(headless.live(name).sessionId, NEW);
  claude.followChat(name, headless.live(name).sessionId);
  const r = await headless.restartChat(name, rec, bin);
  assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.resumed, NEW);
  assert.strictEqual(headless.liveVersion(r.live, null), '4.5.6');
  const argv = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.argv).pop().argv;
  assert.ok(argv.includes('--resume') && argv.includes(NEW) && !argv.includes(OLD));
  assert.strictEqual(claude.get(name).sessionId, NEW);
  assert.strictEqual((await headless.restartChat(name, { ...rec, mode: undefined })).ok, false);
});
