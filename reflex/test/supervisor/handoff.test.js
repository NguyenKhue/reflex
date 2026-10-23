/**
 * handoff.test.js — the document an agent reads when a run stops with `needs_agent`: the exact JSON shape, the
 * agent-safe vs human-only branch, clipping, the allow-list (nothing outside it may leak) and `writeHandoff`.
 * No device: every resume.json below is written by hand with the shapes a real run produces.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHandoff, writeHandoff } = require('../../src/supervisor/handoff');

// A fixed clock so every assertion is a literal value.
const NOW = Date.parse('2026-10-05T10:00:00Z');

const TYPICAL_RESUME = {
  runId: 'r1',
  plan: '/w/plans/p.plan.md',
  planName: 'p',
  appKey: 'app1',
  platform: 'android',
  serial: 'emu',
  legIndex: 1,
  leg: { at: 'a', to: 'b', intent: 'Do it' },
  screen: 'core/a',
  reason: 'no_jev',
  error: 'boom',
  visibleText: ['x', 'y'],
  screenshot: '/r/stuck.png',
  sensitive: { remaining: [], blocksAgent: false },
};

test('a typical resume gives the exact handoff JSON', () => {
  const { json } = buildHandoff({ resume: TYPICAL_RESUME, now: NOW });
  assert.deepEqual(json, {
    v: 1,
    createdAt: '2026-10-05T10:00:00.000Z',
    runId: 'r1',
    plan: 'p',
    planFile: '/w/plans/p.plan.md',
    app: 'app1',
    platform: 'android',
    serial: 'emu',
    leg: { index: 1, at: 'a', to: 'b', intent: 'Do it' },
    screen: 'core/a',
    reason: 'no_jev',
    error: 'boom',
    visibleText: ['x', 'y'],
    screenshot: '/r/stuck.png',
    resume: { command: 'reflex resume r1', agentMayResume: true, sensitiveLegs: [] },
  });
});

test('a sensitive rest of the run blocks the agent and says so in the markdown', () => {
  const { json, markdown } = buildHandoff({
    resume: {
      ...TYPICAL_RESUME,
      sensitive: { remaining: [{ index: 2, reasons: ['screen-input:core/login_password'] }], blocksAgent: true },
    },
    now: NOW,
  });
  assert.equal(json.resume.agentMayResume, false);
  assert.deepEqual(json.resume.sensitiveLegs, [{ index: 2, reasons: ['screen-input:core/login_password'] }]);
  assert.match(markdown, /Do NOT resume it yourself/);
  assert.match(markdown, /3 \(screen-input:core\/login_password\)/);
  assert.doesNotMatch(markdown, /--agent/);
});

test('an agent-safe handoff tells the agent how to continue and what not to touch', () => {
  const { markdown } = buildHandoff({ resume: TYPICAL_RESUME, now: NOW });
  assert.match(markdown, /reflex resume r1 --agent/);
  assert.match(markdown, /Leg 2: `a` → `b` \(Do it\)/);
  assert.match(markdown, /screens\/app1\//);
  assert.match(markdown, /Never type a password, PIN, OTP or any credential/);
  assert.match(markdown, /Never edit `screens\/_shared\/` \(policy\)/);
  assert.match(markdown, /Never copy a value from the screen into a file/);
  // Public text appears as bullet items under its own section.
  assert.match(markdown, /## What the screen shows \(public text only\)\n- x\n- y\n/);
});

test('visible text and errors are clipped', () => {
  const longLine = 'L'.repeat(300);
  const lines = Array.from({ length: 60 }, (unused, index) => (index === 39 ? longLine : `line ${index}`));
  const { json } = buildHandoff({
    resume: { ...TYPICAL_RESUME, visibleText: lines, error: 'E'.repeat(500) },
    now: NOW,
  });
  assert.equal(json.visibleText.length, 40);
  assert.equal(json.visibleText[0], 'line 0');
  assert.equal(json.visibleText[38], 'line 38');
  assert.equal(json.visibleText[39].length, 160);
  assert.equal(json.visibleText[39].endsWith('…'), true);
  assert.equal(json.error.length, 160);
  assert.equal(json.error.endsWith('…'), true);
});

test('nothing outside the allow-list leaks', () => {
  const { json, markdown } = buildHandoff({
    resume: {
      ...TYPICAL_RESUME,
      captures: { code: 'TOPSECRET' },
      data: { password: 'TOPSECRET' },
      useJev: true,
      jevThreshold: 3,
      cwd: '/w',
    },
    now: NOW,
  });
  const serialised = `${JSON.stringify(json)}\n${markdown}`;
  assert.doesNotMatch(serialised, /TOPSECRET/);
  assert.doesNotMatch(serialised, /captures/);
  assert.doesNotMatch(serialised, /cwd/);
  assert.deepEqual(Object.keys(json), [
    'v', 'createdAt', 'runId', 'plan', 'planFile', 'app', 'platform', 'serial',
    'leg', 'screen', 'reason', 'error', 'visibleText', 'screenshot', 'resume',
  ]);
});

test('an empty or missing resume still produces a readable handoff', () => {
  for (const built of [buildHandoff({ now: NOW }), buildHandoff({ resume: null, now: NOW })]) {
    assert.equal(built.json.leg.index, null);
    assert.deepEqual(built.json.visibleText, []);
    assert.equal(built.json.runId, null);
    assert.match(built.markdown, /\(nothing readable\)/);
    assert.match(built.markdown, /\(not identified\)/);
  }
});

test('writeHandoff writes both files into a directory that does not exist yet', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-handoff-')));
  const reportDir = path.join(root, 'nested', 'r1');
  const handoff = buildHandoff({ resume: TYPICAL_RESUME, now: NOW });

  const written = writeHandoff(reportDir, handoff);
  assert.deepEqual(written, { jsonFile: path.join(reportDir, 'handoff.json'), markdownFile: path.join(reportDir, 'handoff.md') });
  assert.deepEqual(JSON.parse(fs.readFileSync(written.jsonFile, 'utf8')), handoff.json);
  const markdown = fs.readFileSync(written.markdownFile, 'utf8');
  assert.equal(markdown, `${handoff.markdown}\n`);
  assert.equal(markdown.endsWith('\n'), true);
});
