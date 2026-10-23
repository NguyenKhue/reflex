/**
 * doctor.js — can this machine run plans? Each check says what is wrong and how to fix it.
 * `level: 'warn'` checks never fail the command (Jev is optional; a running daemon only
 * shortens resume windows).
 */
const { execFileSync } = require('child_process');
const workspace = require('../util/workspace');

function run(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
}

async function doctor({ platform = 'android', serial } = {}) {
  const checks = [];
  const add = (name, ok, detail, hint, level = 'error') => checks.push({ name, ok, level, detail, ...(ok ? {} : { hint }) });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 22 || (major === 22 && minor >= 12), `v${process.versions.node}`, 'install Node >= 22.12 (agent-device requires it)');

  if (platform === 'android') {
    let devices = [];
    try {
      devices = run('adb', ['devices']).split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((cols) => cols[1] === 'device').map((cols) => cols[0]);
      add('adb', true, 'adb on PATH');
    } catch (_) {
      add('adb', false, 'adb not found', 'install Android platform-tools and put adb on PATH');
    }
    const wanted = serial ? devices.includes(serial) : devices.length > 0;
    add('android device', wanted, devices.length ? devices.join(', ') : 'no device in `adb devices`', serial ? `connect ${serial} (USB debugging on) or pass another --serial` : 'connect a device with USB debugging on');
  }

  try {
    await import('agent-device');
    add('agent-device', true, 'importable');
  } catch (_) {
    add('agent-device', false, 'not installed', 'npm install --prefix reflex (Node >= 22.12)');
  }
  try {
    require.resolve('@typesafe-ai/sdk');
    add('@typesafe-ai/sdk', true, 'installed', null, 'warn');
  } catch (_) {
    add('@typesafe-ai/sdk', false, 'not installed — L2 (Jev) disabled', 'npm install --prefix reflex', 'warn');
  }
  if (process.env.REFLEX_DECIDER === 'opencode') {
    add('decider', true, `opencode (${process.env.REFLEX_DECIDER_MODEL || require('../jev/opencodeClient').DEFAULT_MODEL}), free models only`, null, 'warn');
  } else add('TYPESAFE_API_KEY', Boolean(process.env.TYPESAFE_API_KEY), process.env.TYPESAFE_API_KEY ? 'set' : 'not set — L2 (Jev) disabled, stuck steps go straight to needs_agent', 'export TYPESAFE_API_KEY=… (console.typesafe.ai; env only, never commit)', 'warn');

  // Only ever report set/not set: these values are phones, passwords and tokens.
  // Every account name lives under the REFLEX_TEST_* prefix. Missing values are informational: a plan that
  // never logs in needs none of them, and a failed account must not look like a broken machine.
  const missingAccount = 'only needed by plans that log in';
  const envCheck = (names, value) => add(names, Boolean(value), value ? 'set' : `not set — ${missingAccount}`, `put ${names} in workspace/.env (gitignored) or export it`, 'warn');
  envCheck('REFLEX_TEST_PHONE', process.env.REFLEX_TEST_PHONE);
  envCheck('REFLEX_TEST_PASSWORD', process.env.REFLEX_TEST_PASSWORD);
  // Per-platform accounts (…_ANDROID / …_IOS) win over the shared one and are listed only when set,
  // so a single-account setup keeps a quiet doctor.
  const platformBases = ['REFLEX_TEST_PHONE', 'REFLEX_TEST_PASSWORD', 'REFLEX_TEST_PIN'];
  for (const suffix of ['ANDROID', 'IOS']) {
    for (const base of platformBases) {
      if (process.env[`${base}_${suffix}`]) add(`${base}_${suffix}`, true, 'set', null, 'warn');
    }
  }
  try {
    const threshold = require('../util/env').jevThreshold();
    add('JEV_CONFIDENCE_THRESHOLD', true, String(threshold), null, 'warn');
  } catch (error) {
    add('JEV_CONFIDENCE_THRESHOLD', false, error.message, 'set JEV_CONFIDENCE_THRESHOLD to a number in (0, 1] in workspace/.env', 'warn');
  }

  try {
    add('workspace', true, workspace.root());
  } catch (error) {
    add('workspace', false, error.message, 'pass --workspace <dir> or set REFLEX_PROJECT_DIR');
  }

  let daemon = false;
  try {
    daemon = /agent-device/.test(run('pgrep', ['-fl', 'agent-device']));
  } catch (_) {
    daemon = false;
  }
  add('agent-device daemon', !daemon, daemon
    ? 'daemon already running: idle timeout stays at its default (5 min); resume will re-create the session'
    : 'not running (reflex starts it with a 30 min idle timeout)', 'stop it to get the longer idle timeout on the next run', 'warn');

  const ok = checks.every((check) => check.ok || check.level === 'warn');
  return { ok, checks };
}

module.exports = { doctor };
