/**
 * agentLoop.test.js — the Jev-driven loop against a mock backend + mock Jev:
 * no device, no network. Covers the verdicts, the stopping rules, tracing and the
 * deterministic checklist produced from a successful trace.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockBackend } = require('../../src/device/deviceBackend');
const { createMockJev } = require('../../src/jev/jevClient');
const { runAgent, traceToChecklist, INSTRUCTIONS } = require('../../src/jev/agentLoop');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pick the offered action whose description contains `needle`. */
function offeredId(questions, needle) {
  const criteria = questions.nextAction.criteria;
  const id = Object.keys(criteria).find((key) => criteria[key].includes(needle));
  assert.ok(id, `no offered action matches "${needle}"`);
  return id;
}

function answer(id, confidence = 0.95) {
  const probabilities = { [id]: confidence };
  if (id !== 'qa_pass') probabilities.qa_pass = 0.01;
  return { nextAction: { type: 'choice', choice: id, confidence, probabilities } };
}

function homeBackend() {
  return createMockBackend({
    snapshots: [fixtures.homeRaw(), fixtures.sectionRaw()],
    appId: APP,
    onAction: (action, backend) => {
      if (action.kind === 'press') backend.advance();
    }
  });
}

test('a press followed by qa_pass passes in two steps', async () => {
  const backend = homeBackend();
  const jev = createMockJev((state, questions, callIndex) => (
    callIndex === 0 ? answer(offeredId(questions, 'max-api-v2'), 0.97) : answer('qa_pass', 0.99)
  ));

  const result = await runAgent({ backend, jev, task: 'Mở mục max-api-v2 và xác nhận nó đã chạy' });

  assert.equal(result.status, 'pass');
  assert.equal(result.modelVerdict, 'pass');
  assert.equal(result.verified, null);
  assert.equal(result.reason, null);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, 'press');
  assert.equal(result.steps[0].actionId, 'pe15');
  assert.equal(result.steps[0].label, 'max-api-v2');
  assert.equal(result.steps[0].action, 'press "max-api-v2"');
  assert.equal(result.steps[1].kind, 'verdict');
  assert.equal(result.steps[1].confidence, 0.99);
  assert.equal(result.steps[1].top[0][0], 'qa_pass');
  assert.deepEqual(backend.actions.map((action) => action.kind), ['press']);
  assert.equal(backend.actions[0].target.ref, 'e15');
  assert.equal(result.jev.calls, 2);
  assert.ok(Number.isFinite(result.duration_ms));
  assert.ok(INSTRUCTIONS.includes('qa_pass') && INSTRUCTIONS.includes('untrusted'));
});

test('the second step sees the previous screen and history, not the input values', async () => {
  const backend = homeBackend();
  const states = [];
  const jev = createMockJev((state, questions, callIndex) => {
    states.push(state);
    return callIndex === 0 ? answer(offeredId(questions, 'max-api-v2')) : answer('qa_pass');
  });

  await runAgent({ backend, jev, task: 'Đăng nhập', inputs: { phone: '0900000099' } });

  assert.deepEqual(states[0].inputs, ['phone']);
  assert.equal(states[0].previousScreen, null);
  assert.equal(states[0].previousAction, null);
  assert.equal(states[0].history.length, 0);
  assert.equal(states[1].previousAction, 'Tap "max-api-v2"');
  assert.deepEqual(states[1].history, ['Tap "max-api-v2"']);
  assert.ok(states[1].previousScreen.length > 0);
  // Only the input NAMES travel to Jev.
  assert.equal(JSON.stringify(states).includes('0900000099'), false);
});

test('a model pass is rejected when the independent verifier disagrees', async () => {
  const backend = homeBackend();
  const jev = createMockJev((state, questions, callIndex) => (
    callIndex === 0 ? answer(offeredId(questions, 'max-api-v2')) : answer('qa_pass')
  ));

  const rejected = await runAgent({
    backend,
    jev,
    task: 'Mở max-api-v2',
    verify: async ({ backend: checked, snapshot }) => {
      assert.equal(checked, backend);
      assert.ok(Array.isArray(snapshot.nodes));
      return false;
    }
  });
  assert.equal(rejected.status, 'fail');
  assert.equal(rejected.modelVerdict, 'pass');
  assert.equal(rejected.verified, false);
  assert.equal(rejected.reason, 'model_pass_unverified');

  const accepted = await runAgent({ backend: homeBackend(), jev, task: 'Mở max-api-v2', verify: async () => true });
  assert.equal(accepted.status, 'pass');
  assert.equal(accepted.verified, true);
  assert.equal(accepted.reason, null);
});

test('a failing verifier is treated as unverified, not as a crash', async () => {
  const backend = homeBackend();
  const jev = createMockJev((state, questions, callIndex) => (
    callIndex === 0 ? answer(offeredId(questions, 'max-api-v2')) : answer('qa_pass')
  ));

  const result = await runAgent({
    backend,
    jev,
    task: 'Mở max-api-v2',
    verify: async () => { throw new Error('logcat unavailable'); }
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'model_pass_unverified');
  assert.equal(result.verified, false);
});

test('a model qa_fail / need_input / incomplete is reported as it is', async () => {
  for (const [id, expected] of [['qa_fail', 'fail'], ['need_input', 'need_input'], ['incomplete', 'incomplete']]) {
    const backend = createMockBackend({ snapshots: [fixtures.sectionRaw()], appId: APP });
    const jev = createMockJev(() => answer(id));
    const result = await runAgent({ backend, jev, task: 'Kiểm tra màn hình' });

    assert.equal(result.modelVerdict, expected);
    assert.equal(result.status, expected);
    assert.equal(result.verified, null);
    assert.equal(result.steps.length, 1);
  }
});

test('a repeated action on an unchanged screen stops with no_progress', async () => {
  const backend = createMockBackend({ snapshots: [fixtures.homeRaw()], appId: APP });
  const jev = createMockJev((state, questions) => answer(offeredId(questions, 'Scroll down')));

  const result = await runAgent({ backend, jev, task: 'Cuộn xuống' });

  assert.equal(result.status, 'no_progress');
  assert.equal(result.steps.length, 3);
  assert.match(result.reason, /repeated 3 times/);
  // The third repeat is reported but never executed.
  assert.equal(backend.actions.length, 2);
  assert.deepEqual(backend.actions.map((action) => action.direction), ['down', 'down']);
});

test('the step budget ends the run', async () => {
  const backend = createMockBackend({
    snapshots: fixtures.scrollingRaw(6),
    appId: APP,
    onAction: (action, mock) => mock.advance()
  });
  const jev = createMockJev((state, questions) => answer(offeredId(questions, 'Scroll down')));

  const result = await runAgent({ backend, jev, task: 'Cuộn liên tục', maxSteps: 4 });

  assert.equal(result.status, 'max_steps');
  assert.equal(result.steps.length, 4);
  assert.match(result.reason, /step budget of 4/);
  assert.equal(new Set(result.steps.map((step) => step.signature)).size, 4);
});

test('a low-confidence answer stops the run before acting', async () => {
  const backend = createMockBackend({ snapshots: [fixtures.homeRaw()], appId: APP });
  const jev = createMockJev((state, questions) => answer(offeredId(questions, 'Đăng nhập'), 0.4));

  const result = await runAgent({ backend, jev, task: 'Đăng nhập', minConfidence: 0.9 });

  assert.equal(result.status, 'low_confidence');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].confidence, 0.4);
  assert.equal(backend.actions.length, 0);
});

test('the time budget ends the run', async () => {
  const backend = createMockBackend({ snapshots: [fixtures.homeRaw()], appId: APP });
  const jev = createMockJev(async (state, questions) => {
    await sleep(30);
    return answer(offeredId(questions, 'Scroll down'));
  });

  const result = await runAgent({ backend, jev, task: 'Cuộn xuống', timeoutMs: 10, maxSteps: 5 });

  assert.equal(result.status, 'timeout');
  assert.equal(result.steps.length, 1);
  assert.match(result.reason, /time budget of 10ms/);
});

test('an unknown action id and a backend failure both stop with error', async () => {
  const unknownJev = createMockJev(() => ({ nextAction: { type: 'choice', choice: 'nope', confidence: 1 } }));
  const unknown = await runAgent({
    backend: createMockBackend({ snapshots: [fixtures.homeRaw()], appId: APP }),
    jev: unknownJev,
    task: 'x'
  });
  assert.equal(unknown.status, 'error');
  assert.match(unknown.reason, /unknown action "nope"/);
  assert.equal(unknown.steps.length, 0);

  const backend = createMockBackend({ snapshots: [fixtures.homeRaw()], appId: APP, onAction: (action, mock) => mock.advance() });
  backend.press = async () => { throw new Error('COMMAND_FAILED: device offline'); };
  const jev = createMockJev((state, questions) => answer(offeredId(questions, 'Đăng nhập')));
  const failed = await runAgent({ backend, jev, task: 'Đăng nhập' });

  assert.equal(failed.status, 'error');
  assert.match(failed.reason, /device offline/);
  assert.equal(failed.steps.length, 1);
});

test('a fill sends the value to the backend and keeps it out of the trace', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-trace-'));
  try {
    const inputs = { phone: '0900000099' };
    const states = [];
    const backend = createMockBackend({
      snapshots: [fixtures.loginRaw(), fixtures.homeRaw()],
      appId: APP,
      onAction: (action, mock) => {
        if (action.kind === 'fill') mock.advance();
      }
    });
    const jev = createMockJev((state, questions, callIndex) => {
      states.push(state);
      return callIndex === 0 ? answer(offeredId(questions, 'input "phone"'), 0.93) : answer('qa_pass');
    });

    const result = await runAgent({ backend, jev, task: 'Đăng nhập bằng số điện thoại', inputs, artifactsDir });

    assert.equal(result.status, 'pass');
    assert.equal(result.artifactsDir, artifactsDir);
    const fill = backend.actions.find((action) => action.kind === 'fill');
    assert.equal(fill.text, '0900000099');
    assert.equal(fill.target.ref, 'e51');

    const trace = fs.readFileSync(path.join(artifactsDir, 'trace.jsonl'), 'utf8');
    const lines = trace.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].input, 'phone');
    assert.equal(lines[0].label, undefined);
    assert.equal(lines[0].fieldIndex, 0);
    assert.equal(lines[0].action, 'fill "phone" into text field #1');
    assert.equal(lines[1].kind, 'verdict');
    // Neither the typed value nor the pre-filled field value reach the trace,
    // the Jev state, or the replayed checklist.
    assert.equal(trace.includes('0900000099'), false);
    assert.equal(trace.includes('0900000002'), false);
    assert.equal(JSON.stringify(states).includes('0900000099'), false);
    assert.deepEqual(traceToChecklist(result.steps, { inputs }), [
      { tool: 'fill', args: { index: 0, text: '{phone}' } }
    ]);

    assert.ok(fs.existsSync(path.join(artifactsDir, 'snapshot-1.json')));
    const snapshot = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'snapshot-1.json'), 'utf8'));
    assert.equal(snapshot.generation, 7);
    assert.ok(snapshot.nodes.some((node) => node.pinned === '@e51~s7' && node.value === '[redacted]'));
    assert.deepEqual(backend.screenshots, [path.join(artifactsDir, 'final.png')]);
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('onStep is called for every recorded step', async () => {
  const backend = homeBackend();
  const seen = [];
  const jev = createMockJev((state, questions, callIndex) => (
    callIndex === 0 ? answer(offeredId(questions, 'max-api-v2')) : answer('qa_pass')
  ));

  await runAgent({ backend, jev, task: 'Mở max-api-v2', onStep: (entry) => seen.push(entry.step) });

  assert.deepEqual(seen, [1, 2]);
});

test('traceToChecklist replays only the deterministic steps', () => {
  const steps = [
    { step: 1, kind: 'press', label: 'max-api-v2' },
    { step: 2, kind: 'fill', fieldIndex: 1, input: 'phone' },
    { step: 3, kind: 'scroll', direction: 'down' },
    { step: 4, kind: 'wait' },
    { step: 5, kind: 'back' },
    { step: 6, kind: 'verdict' }
  ];

  assert.deepEqual(traceToChecklist(steps), [
    { tool: 'tap_text', args: { text: 'max-api-v2', exact: true } },
    { tool: 'fill', args: { index: 1, text: '{phone}' } },
    { tool: 'scroll', args: { direction: 'down' } },
    { tool: 'back' }
  ]);
  assert.deepEqual(traceToChecklist(steps, { inputs: { phone: '0900000099' } }).map((step) => step.tool), ['tap_text', 'fill', 'scroll', 'back']);
  assert.throws(() => traceToChecklist(steps, { inputs: { other: 'x' } }), /undeclared input "phone"/);
  assert.deepEqual(traceToChecklist([{ kind: 'fill', input: 'pin' }]), [{ tool: 'fill', args: { index: 0, text: '{pin}' } }]);
  assert.deepEqual(traceToChecklist(null), []);
});
