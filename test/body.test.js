const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { readBody } = require('../lib/util');

function fakeReq(buf, cut) {
  const req = new EventEmitter();
  setImmediate(() => { for (let i = 0; i < buf.length; i += cut) req.emit('data', buf.subarray(i, i + cut)); req.emit('end'); });
  return req;
}

test('multi-byte characters split across chunks survive', async () => {
  const text = 'čćžšđ 😀 '.repeat(5000);
  const buf = Buffer.from(JSON.stringify({ text }));
  for (const cut of [1, 2, 3, 7, 16384]) assert.strictEqual((await readBody(fakeReq(buf, cut), 1e7)).text, text);
});

test('limit counts bytes and rejects with 413', async () => {
  const buf = Buffer.from(JSON.stringify({ text: 'č'.repeat(600) }));
  await assert.rejects(readBody(fakeReq(buf, 100), 1000), e => e.status === 413);
});

test('empty body is an empty object, bad JSON is 400', async () => {
  assert.deepStrictEqual(await readBody(fakeReq(Buffer.alloc(0), 10)), {});
  await assert.rejects(readBody(fakeReq(Buffer.from('{'), 10)), e => e.status === 400);
});
