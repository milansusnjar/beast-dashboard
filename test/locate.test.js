const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SID = '11111111-2222-4333-8444-555555555555';

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-loc-')));
  const old = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { process.env.HOME = old; fs.rmSync(dir, { recursive: true, force: true }); });
  const headless = require('../lib/headless');
  const save = (account, cwd) => {
    const f = headless.transcriptOf(cwd, account, SID);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{}\n');
    return f;
  };
  const folder = rel => { const d = path.join(dir, 'dev', rel); fs.mkdirSync(d, { recursive: true }); return d; };
  return { dir, headless, save, folder };
}

test('locateTranscript: walks up from a subfolder to the folder that holds the conversation', t => {
  const h = home(t);
  const top = h.folder('shop');
  const sub = h.folder('shop/api/src');
  const file = h.save('personal', top);
  assert.deepStrictEqual(h.headless.locateTranscript(sub, 'personal', SID), { dir: top, file, account: 'personal' });
  assert.strictEqual(h.headless.locateTranscript(top, 'personal', SID).dir, top);
});

test('locateTranscript: nothing in the folder or its parents gives null', t => {
  const h = home(t);
  const top = h.folder('shop');
  const other = h.folder('other/deep');
  h.save('personal', top);
  assert.strictEqual(h.headless.locateTranscript(other, 'personal', SID), null);
  assert.strictEqual(h.headless.locateTranscript(top, 'company', SID), null);
  assert.strictEqual(h.headless.locateTranscript(top, 'personal', 'not-an-id'), null);
  assert.strictEqual(h.headless.locateTranscript('relative/dir', 'personal', SID), null);
});

test('locateTranscript: without an account both config dirs are tried and the account where it is found comes back', t => {
  const h = home(t);
  const top = h.folder('work');
  const sub = h.folder('work/pkg');
  h.save('company', top);
  const r = h.headless.locateTranscript(sub, null, SID);
  assert.strictEqual(r.account, 'company');
  assert.strictEqual(r.dir, top);
});

test('recordAccount: stored account first, then the -company suffix, else unknown', t => {
  const h = home(t);
  assert.strictEqual(h.headless.recordAccount({ tmux: 'claude-x', account: 'company' }), 'company');
  assert.strictEqual(h.headless.recordAccount({ tmux: 'claude-x-company', account: null }), 'company');
  assert.strictEqual(h.headless.recordAccount({ tmux: 'claude-x', account: null }), null);
  assert.strictEqual(h.headless.recordAccount({ tmux: 'sh-1' }), null);
});
