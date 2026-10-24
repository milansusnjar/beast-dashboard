const test = require('node:test');
const assert = require('node:assert');
const { paneStateOf } = require('../lib/claude');

const RULE = '─'.repeat(60);
const footer = ['  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const idleBox = draft => [RULE, '❯ ' + draft, RULE, ...footer];

test('a reply that quotes the limit and permission phrases is idle, not limit or permission', () => {
  const raw = ['> how does the dashboard detect states?', '', '⏺ It looks for "usage limit reached" and for', '  "Do you want to proceed?" in the pane, and', '  You\'ve hit your session limit is the new wording.', '  Then it pushes.', '', ...idleBox('')];
  assert.strictEqual(paneStateOf(raw).paneState, 'idle');
});

test('a real limit message right above the prompt box is a limit, with the reset time', () => {
  const raw = ['> fix the tests', '', '⏺ Running the suite now.', '  ⎿  You\'ve hit your session limit · resets 11:40am (Europe/Sarajevo)', '', ...idleBox('')];
  const r = paneStateOf(raw);
  assert.strictEqual(r.paneState, 'limit');
  assert.strictEqual(r.limitText, 'You\'ve hit your session limit · resets 11:40am (Europe/Sarajevo)');
});

test('the rate-limit options menu is a limit', () => {
  const raw = ['⏺ Done with step 1.', '  ⎿  Claude usage limit reached. Your limit will reset at 3pm', '', RULE, ' What do you want to do?', ' ❯ 1. Stop and wait for limit to reset', '   2. Upgrade your plan'];
  assert.strictEqual(paneStateOf(raw).paneState, 'limit');
});

test('the older and API-error limit wordings are a limit', () => {
  for (const line of ['  ⎿  Claude AI usage limit reached|1761235200', '  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}']) {
    assert.strictEqual(paneStateOf(['⏺ Working on it.', line, '', ...idleBox('')]).paneState, 'limit', line);
  }
});

test('a real permission dialog is a permission', () => {
  const raw = ['⏺ Bash(rm -rf build)', '', RULE, ' Bash command', '', '   rm -rf build', '   Remove the build folder', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for rm commands in this folder', '   3. No, and tell Claude what to do differently (esc)'];
  assert.strictEqual(paneStateOf(raw).paneState, 'permission');
});

test('a draft in the prompt box is kept', () => {
  assert.deepStrictEqual(paneStateOf(['⏺ ok', '', ...idleBox('ship it')]), { paneState: 'idle', draft: 'ship it', limitText: null });
});
