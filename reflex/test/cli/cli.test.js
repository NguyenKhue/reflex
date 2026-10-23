/**
 * cli.test.js — the CLI surface (spawned like an agent would), plan validate / context show,
 * MCP run_status, and an MCP stdio smoke test. No device.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { parseArgs } = require('../../src/cli/args');
const { contextShow, planValidate } = require('../../src/cli/planCommands');
const handlers = require('../../src/mcp/handlers');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'workspace');
/** The manifest marker the tool reads, written over the copy so the temp root is a workspace. */
const MANIFEST = {
  name: 'fixture',
  reportsDir: 'reports',
  defaults: { platform: 'android', account: { phone: '0900000000', password: '123456' } },
  apps: { example: { android: { package: 'com.example.app', activity: 'com.example.app.MainActivity' } } },
};

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-cli-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'reflex.workspace.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  workspace.reset();
  workspace.setOverride(root);
});
afterEach(() => workspace.reset());

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, REFLEX_PROJECT_DIR: root } });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return { code: result.status, markers, marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null, stderr: result.stderr };
}

test('parseArgs handles --k v, --k=v, bare flags and --no-x', () => {
  assert.deepEqual(parseArgs(['run', 'p.md', '--case', 'a', '--x=1', '--json', '--no-jev']), {
    _: ['run', 'p.md'], flags: { case: 'a', x: '1', json: true, jev: false },
  });
});

test('plan validate prints one marker and exits by verdict', () => {
  const good = cli(['plan', 'validate', 'plans/example/login.plan.md', '--json']);
  assert.equal(good.code, 0);
  assert.equal(good.markers.length, 1);
  assert.equal(good.marker.ok, true);
  assert.deepEqual([good.marker.plan, good.marker.legs, good.marker.rows], ['example_login_basic', 1, 2]);
  const bad = cli(['plan', 'validate', 'plans/example/bad.plan.md']);
  assert.equal(bad.code, 1);
  assert.equal(bad.marker.ok, false);
  assert.ok(bad.marker.errors.length > 3);
  const missing = cli(['plan', 'validate', 'plans/example/ghost.plan.md']);
  assert.equal(missing.code, 1);
  assert.match(missing.marker.error, /plan not found/);
  // A legacy plan is refused by the loader, with the rewrite hint (not a stack trace).
  const legacy = cli(['plan', 'validate', 'plans/example/legacy.plan.md']);
  assert.equal(legacy.code, 1);
  assert.match(legacy.marker.error, /"steps" plans are no longer supported/);
});

test('plan validate reports a knowledge base that cannot be read', () => {
  fs.writeFileSync(path.join(root, 'screens', 'example', 'core', 'login', 'normal.yml'), '- to: [oops');
  const result = planValidate({ plan: 'plans/example/login.plan.md' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /invalid YAML/);
});

test('context show lists the app notes, its screens and its plans', () => {
  const shown = cli(['context', 'show', '--app', 'example', '--json']);
  assert.equal(shown.code, 0);
  assert.equal(shown.marker.context, path.join('screens', 'example', '_app', 'context.md'));
  assert.match(shown.marker.contextText, /Example app \(fixture\)/);
  assert.deepEqual(shown.marker.screens.map((screen) => screen.id), ['core/home', 'core/login', 'core/password']);
  assert.deepEqual(shown.marker.screens.find((screen) => screen.id === 'core/home').cases, { verified: 1, learned: 0, draft: 0 });
  assert.equal(shown.marker.screens.find((screen) => screen.id === 'core/password').cases.verified, 0);
  // The fixture also holds plans that only exist to be rejected; the login plan is the good one.
  const loginPlan = shown.marker.plans.find((item) => item.name === 'example_login_basic');
  assert.deepEqual([loginPlan.file, loginPlan.status], [path.join('plans', 'example', 'login.plan.md'), 'draft']);
  assert.match(loginPlan.goal, /reach the password screen/);
  assert.ok(shown.marker.plans.every((item) => item.file.startsWith(path.join('plans', 'example'))));
  assert.equal(cli(['--help']).code, 0);
  const unknown = cli(['nope']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.marker.error, /unknown command/);
});

test('context show on an app without screens explains itself', () => {
  const shown = contextShow({ app: 'ghost' });
  assert.equal(shown.context, null);
  assert.deepEqual(shown.screens, []);
  assert.deepEqual(shown.plans, []);
  assert.match(shown.error, /no screens directory for app "ghost"/);
});

function fabricateRun(runId, result, extra = {}) {
  const dir = path.join(root, 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId, updatedAt: new Date().toISOString(), ...extra, result }));
  return dir;
}

test('run_status reports crashed when the run process is gone', async () => {
  const child = spawnSync(process.execPath, ['-e', ''], {});
  assert.equal(child.status, 0);
  const deadPid = child.pid;
  fabricateRun('dead', null, { state: 'running', pid: deadPid });
  fs.writeFileSync(path.join(root, 'reports', 'dead', 'run.log'), 'line1\nboom\n');
  const status = await handlers.runStatus({ runId: 'dead' });
  assert.equal(status.state, 'crashed');
  assert.match(status.logTail, /boom/);
  fabricateRun('fine', { status: 'pass' }, { state: 'done', pid: deadPid });
  assert.equal((await handlers.runStatus({ runId: 'fine' })).state, 'done');
});

test('run_start spawns a detached run and records its pid', async () => {
  const calls = [];
  const fakeSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: 424242, unref() {} };
  };
  const started = await handlers.runStart({ plan: 'plans/example/login.plan.md', case: 'r1', noJev: true }, { spawnFn: fakeSpawn });
  assert.match(started.runId, /^example_login_basic_\d{8}_\d{6}$/);
  assert.ok(calls[0].args.includes('--run-id') && calls[0].args.includes('--no-jev') && calls[0].args.includes('r1'));
  assert.equal(calls[0].options.detached, true);
  const status = JSON.parse(fs.readFileSync(path.join(started.reportDir, 'status.json'), 'utf8'));
  assert.equal(status.pid, 424242);
  assert.equal(status.state, 'starting');
});

test('run_start forwards --no-learn and --jev-threshold to the run', async () => {
  const calls = [];
  const fakeSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: 424243, unref() {} };
  };
  await handlers.runStart({ plan: 'plans/example/login.plan.md', noLearn: true, jevThreshold: 0.9 }, { spawnFn: fakeSpawn });
  assert.ok(calls[0].args.includes('--no-learn'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--jev-threshold') + 1], '0.9');
});

test('the MCP server lists its eight tools over stdio', async () => {
  const child = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, REFLEX_PROJECT_DIR: root }, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  let buffer = '';
  const listed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tools/list reply')), 10000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const message = JSON.parse(line);
        lines.push(message);
        if (message.id === 2) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  try {
    const reply = await listed;
    assert.deepEqual(
      reply.result.tools.map((tool) => tool.name),
      ['context_show', 'plan_validate', 'snapshot', 'screen_capture', 'screen_identify', 'run_start', 'resume_start', 'run_status'],
    );
  } finally {
    child.kill();
  }
});
