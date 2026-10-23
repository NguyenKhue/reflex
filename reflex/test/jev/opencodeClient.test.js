const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createOpencodeClient, extractJson, runOpencode, FREE_MODEL } = require('../../src/jev/opencodeClient');
const { choice, noul } = require('../../src/jev/jevClient');
const { createDefaultRegistry } = require('../../src/core/builtins');

const options = { a: 'tap A', b: 'tap B' };

test('a choice answer is validated against the closed set and carries confidence', async () => {
  const prompts = [];
  const client = createOpencodeClient({ model: 'opencode/x-free', runner: async ({ prompt }) => { prompts.push(prompt); return 'Sure: {"choice":"b","confidence":0.9}'; } });
  const response = await client.ask({ screen: 'S' }, { nextAction: choice('pick', options) });
  assert.deepEqual(response.answers.nextAction, { choice: 'b', confidence: 0.9 });
  assert.equal(response.model, 'opencode/x-free');
  assert.match(prompts[0], /tap A/);
  assert.equal(client.stats().calls, 1);
});

test('a choice outside the options is an error, never passed on', async () => {
  const client = createOpencodeClient({ model: 'opencode/x-free', runner: async () => '{"choice":"rm -rf","confidence":1}' });
  await assert.rejects(client.ask({}, { nextAction: choice('pick', options) }), /not one of the options/);
});

test('a noul question returns a clamped probability', async () => {
  const client = createOpencodeClient({ model: 'opencode/x-free', runner: async () => '```json\n{"noul":1.7}\n```' });
  const response = await client.ask({}, { verdict: noul('is it?') });
  assert.equal(response.answers.verdict.noul, 1);
});

test('only free opencode models are accepted', () => {
  for (const bad of ['opencode/gpt-5.5', 'openai/foo-free', 'foo-free']) {
    assert.throws(() => createOpencodeClient({ model: bad }), /not a free opencode model/);
  }
  assert.ok(FREE_MODEL.test('opencode/jev-1.13-free'));
});

test('extractJson rejects text without an object', () => {
  assert.throws(() => extractJson('no json here'), /no JSON object/);
});

test('runOpencode closes stdin, collects text events and reports provider errors', async () => {
  const fake = (events) => (bin, args, opts) => {
    assert.equal(opts.stdio[0], 'ignore');
    assert.deepEqual(args.slice(0, 4), ['run', '-m', 'opencode/x-free', '--format']);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', events.map((e) => JSON.stringify(e)).join('\n')); child.emit('close', 0); });
    return child;
  };
  const ok = await runOpencode({ model: 'opencode/x-free', prompt: 'p', timeoutMs: 1000, spawnFn: fake([{ type: 'text', part: { text: '{"a":1}' } }]) });
  assert.equal(ok, '{"a":1}');
  await assert.rejects(
    runOpencode({ model: 'opencode/x-free', prompt: 'p', timeoutMs: 1000, spawnFn: fake([{ type: 'error', error: { message: 'Model unavailable: opencode/x-free' } }]) }),
    /Model unavailable/
  );
});

test('the opencode decider is registered and speaks the decider contract', async () => {
  const jev = createOpencodeClient({ model: 'opencode/x-free', runner: async () => '{"choice":"a","confidence":0.8}' });
  const decider = createDefaultRegistry().create('decider', 'opencode', { jev });
  const result = await decider.decide({ state: {}, instruction: 'pick', options });
  assert.equal(result.choice, 'a');
  assert.equal(result.confidence, 0.8);
});
