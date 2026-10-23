/**
 * explore.js — let Jev walk the app toward a goal and report the path it took. Used when there
 * is no knowledge of a screen at all; what it finds is a hint for the agent, which turns it
 * into screen cases (`screens/<app>/…/normal.yml`) instead of into a step plan.
 */
const fs = require('fs');
const path = require('path');
const workspace = require('../util/workspace');
const { resolveApp } = require('../runner/app');
const { stamp } = require('../runner/run');

async function explore({ app, goal, inputs = {}, maxSteps = 20, minConfidence = 0, platform = 'android', serial, udid, noLaunch = false, deps = {} }) {
  if (!goal) throw new Error('explore requires --goal "<english goal>"');
  if (!app) throw new Error('explore requires --app <key>');
  const createJev = deps.createJev || (() => {
    if (!process.env.TYPESAFE_API_KEY) throw new Error('explore requires TYPESAFE_API_KEY (the Jev model client)');
    return require('../jev/jevClient').createJevClient();
  });
  const createBackend = deps.createBackend || ((opts) => require('../device/deviceBackend').createDeviceBackend(opts));
  const { runAgent } = require('../jev/agentLoop');

  const target = resolveApp({ name: 'explore', app }, {}, platform);
  const reportDir = path.join(workspace.reportsDir(), `explore_${stamp(Date.now())}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const jev = createJev();
  const backend = createBackend({ platform, serial, udid, session: 'reflex-explore', appId: target.package });
  try {
    if (!noLaunch) await backend.open({ app: target.package, activity: target.activity, relaunch: true });
    const run = await runAgent({
      backend,
      jev,
      task: goal,
      inputs,
      maxSteps,
      minConfidence,
      artifactsDir: reportDir,
      onStep: (entry) => process.stderr.write(`[reflex] explore #${entry.step} ${entry.action} (conf ${entry.confidence})\n`),
    });
    return { status: run.status, reason: run.reason, modelVerdict: run.modelVerdict, steps: run.steps.length, jev: run.jev, reportDir };
  } finally {
    try { await backend.close(); } catch (_) { /* best effort */ }
  }
}

module.exports = { explore };
