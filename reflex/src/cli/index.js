/**
 * index.js — `reflex <command>`. Every command ends with exactly one
 * `REFLEX_JSON <json>` line on stdout (agents parse it); human output goes to stderr, or to
 * stdout before the marker unless `--json`.
 */
const workspace = require('../util/workspace');
const { MARKER } = require('../util/markers');
const { parseArgs, str } = require('./args');

const USAGE = `reflex — run agent-authored app flow plans on agent-device (decider fallback)

Usage: reflex <command> [options] [--workspace <dir>] [--json]

  doctor [--platform android|ios] [--serial s]        toolchain, device, agent-device, Jev key, workspace
  context build --app <key> --src <app source dir>    source hints → screens/<app>/_app/source/
  context show --app <key>                            app notes + screens (case counts) + plans
  plan validate <plan>                                check a flow plan and its screens without touching the device
  run <plan> [--case id] [--serial s] [--platform p] [--app pkg]
             [--screenshots all|fail|none] [--no-jev] [--jev-threshold n] [--no-learn] [--run-id id] [--max-jev-calls n] [--agent]
  resume <runId> [--plan p] [--agent]                continue a run that stopped with needs_agent (from its leg)
  --agent                                             mark the caller as an agent: refuse plans/resumes that would enter credentials (always on for the MCP server)
  snapshot [--serial s] [--platform p] [--app key]    visible texts on the device now
  screen capture --as <group/screen> --app <key> [--serial s] [--platform p]   snapshot → draft screen.md
  screen list --app <key>                             screens of an app + case counts by status
  screen identify --app <key> [--serial s] [--platform p]   which screen the device shows now
  stats [--plan name] [--platform p] [--since date]    pass / straight-through / decider-call rates from the run ledger
  knowledge review --app <key> [--status review|all|learned|draft|verified]   cases and rules the runner learned, with their counters
  app init <key> --package <android package> [--activity a] [--bundle-id <ios id>]   register a new app: manifest entry + screens/<key>/_app/
  supervise <plan> [run options] [--agent-cmd "<cmd>"] [--agent-env A,B] [--max-rounds n] [--no-resume] [--agent-timeout-min n] [--agent]
             run; on needs_agent hand the run to an agent command, keep its knowledge edits provisional
  supervise approve|reject|status <runId>             a human keeps (approve) or undoes (reject) what the agent changed
  hygiene scan [--root dir] [--rules a.json,b.json] [--no-defaults]   find internal hosts, tokens, keys, secret literals and real-looking phone numbers before sharing
  version                                             print the reflex version, the plugin contract version and the Node version (also: --version)
  explore --app <key> --goal "<english goal>" [--inputs '{"name":"value"}'] [--max-steps 20]
  mcp                                                 MCP server on stdio

A plan is a chain of screen legs (at → to); how to walk each screen lives in
screens/<app>/ of the workspace. Exit codes: 0 pass/ok, 1 fail/blocked/error/invalid, 3 needs_agent.`;

function emit(payload, { json }) {
  if (!json && payload && typeof payload.contextText === 'string') process.stdout.write(`${payload.contextText}\n`);
  const { contextText, ...rest } = payload || {};
  process.stdout.write(`${MARKER} ${JSON.stringify(json ? payload : rest)}\n`);
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

async function main(argv) {
  const { _: positionals, flags } = parseArgs(argv);
  const [command, sub] = positionals;
  const json = flags.json === true;
  if (flags.help || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (flags.version === true || command === 'version') {
    const { versionInfo, versionLine } = require('../util/version');
    const info = versionInfo();
    note(versionLine(info));
    emit({ ok: true, ...info }, { json });
    return 0;
  }
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  if (str(flags, 'workspace')) workspace.setOverride(str(flags, 'workspace'));
  // Config (account, threshold, tokens) lives in <workspace>/.env; a missing workspace is fine (doctor).
  try {
    const root = workspace.tryRoot();
    if (root) require('../util/env').loadWorkspaceEnv(root);
  } catch (error) {
    note(`reflex: cannot load .env: ${error.message || error}`);
  }
  const platform = str(flags, 'platform') || undefined;
  const serial = str(flags, 'serial') || process.env.ANDROID_SERIAL || undefined;
  const udid = str(flags, 'udid') || undefined;

  try {
    switch (command) {
      case 'doctor': {
        const result = await require('./doctor').doctor({ platform: platform || 'android', serial });
        if (!json) for (const check of result.checks) note(`${check.ok ? '✓' : (check.level === 'warn' ? '!' : '✗')} ${check.name}: ${check.detail}${check.hint ? ` → ${check.hint}` : ''}`);
        emit(result, { json });
        return result.ok ? 0 : 1;
      }
      case 'context': {
        const commands = require('./planCommands');
        if (sub === 'build') {
          const result = commands.contextBuild({ app: str(flags, 'app'), src: str(flags, 'src') });
          emit(result, { json });
          return 0;
        }
        if (sub === 'show') {
          const result = commands.contextShow({ app: str(flags, 'app') });
          if (!json && !result.context) note(`no context pack yet for "${result.app}" — run: reflex context build --app ${result.app} --src <app source>`);
          emit(result, { json });
          return 0;
        }
        break;
      }
      case 'plan': {
        const commands = require('./planCommands');
        if (sub === 'validate') {
          const result = commands.planValidate({ plan: positionals[2] });
          if (!json) {
            for (const error of result.errors) note(`✗ ${error}`);
            for (const warning of result.warnings) note(`! ${warning}`);
            note(result.ok ? `✓ ${result.plan}: ${result.legs} legs, ${result.rows} row(s)` : `✗ ${result.errors.length} error(s)`);
          }
          emit(result, { json });
          return result.ok ? 0 : 1;
        }
        break;
      }
      case 'run': {
        const { runPlan } = require('../runner/run');
        const { exitCode } = await runPlan({
          planPath: positionals[1],
          caseId: str(flags, 'case'),
          platform,
          serial,
          udid,
          app: str(flags, 'app'),
          screenshots: str(flags, 'screenshots') || 'fail',
          useJev: flags.jev !== false,
          jevThreshold: str(flags, 'jev-threshold') || undefined,
          learn: flags.learn !== false,
          runId: str(flags, 'run-id') || undefined,
          maxJevCalls: Number(str(flags, 'max-jev-calls')) || 30,
          actor: flags.agent === true ? 'agent' : 'human',
        });
        return exitCode;
      }
      case 'resume': {
        const { resumeRun } = require('../runner/run');
        const { exitCode } = await resumeRun(positionals[1], { planPath: str(flags, 'plan') || undefined, actor: flags.agent === true ? 'agent' : 'human' });
        return exitCode;
      }
      case 'snapshot': {
        const result = await require('./snapshot').snapshot({ platform: platform || 'android', serial, udid, app: str(flags, 'app') });
        if (!json) {
          for (const text of result.texts) note(`  ${text}`);
          for (const field of result.fields) note(`  [${field}]`);
        }
        emit(result, { json });
        return 0;
      }
      case 'screen': {
        const commands = require('./screenCommands');
        const app = str(flags, 'app');
        if (sub === 'capture') {
          const result = await commands.screenCapture({ as: str(flags, 'as'), app, platform: platform || 'android', serial, udid });
          if (!json) note(`✓ ${result.created ? 'created' : 'updated'} ${result.file} (${result.texts} texts, ${result.ids.length} ids, ${result.dropped} dropped)`);
          emit(result, { json });
          return 0;
        }
        if (sub === 'list') {
          const result = commands.screenList({ app });
          if (!json) {
            for (const screen of result.screens) {
              const { verified, learned, draft } = screen.cases;
              note(`  ${screen.id}: ${verified} verified, ${learned} learned, ${draft} draft, ${screen.exceptions} exception(s)`);
            }
            note(`${result.screens.length} screen(s) for app "${result.app}"`);
          }
          emit(result, { json });
          return 0;
        }
        if (sub === 'identify') {
          const result = await commands.screenIdentify({ app, platform: platform || 'android', serial, udid });
          if (!json) {
            note(result.screen ? `screen: ${result.screen}` : 'screen: (not identified)');
            if (result.ambiguous.length) note(`! ambiguous: ${result.ambiguous.join(', ')}`);
          }
          emit(result, { json });
          // "No screen" is the answer to "why does this leg not move?", so it is not a success.
          return result.screen ? 0 : 1;
        }
        break;
      }
      case 'explore': {
        const result = await require('./explore').explore({
          app: str(flags, 'app'),
          goal: str(flags, 'goal'),
          inputs: str(flags, 'inputs') ? JSON.parse(str(flags, 'inputs')) : {},
          maxSteps: Number(str(flags, 'max-steps')) || 20,
          minConfidence: Number(str(flags, 'min-confidence')) || 0,
          platform: platform || 'android',
          serial,
          udid,
          noLaunch: flags.launch === false,
        });
        emit(result, { json });
        return result.status === 'pass' ? 0 : 1;
      }
      case 'stats': {
        const commands = require('./statsCommands');
        const result = commands.statsCommand({ plan: str(flags, 'plan'), platform, since: str(flags, 'since') });
        if (!json) for (const line of commands.formatStats(result)) note(line);
        emit(result, { json });
        return 0;
      }
      case 'knowledge': {
        if (sub === 'review') {
          const commands = require('./knowledgeCommands');
          const result = commands.knowledgeReview({ app: str(flags, 'app'), status: str(flags, 'status') || 'review' });
          if (!json) for (const line of commands.formatReview(result)) note(line);
          emit(result, { json });
          return 0;
        }
        break;
      }
      case 'app': {
        if (sub === 'init') {
          const commands = require('./appCommands');
          const result = commands.appInit({
            key: positionals[2],
            package: str(flags, 'package'),
            activity: str(flags, 'activity'),
            bundleId: str(flags, 'bundle-id'),
          });
          if (!json) note(`✓ app "${result.app}" registered in ${result.manifest}; created ${result.created.join(', ')}`);
          emit(result, { json });
          return 0;
        }
        break;
      }
      case 'supervise': {
        const supervise = require('../supervisor/supervise');
        if (sub === 'approve' || sub === 'reject' || sub === 'status') {
          const runId = positionals[2];
          if (!runId) throw new Error(`supervise ${sub} requires a runId`);
          const state = sub === 'approve' ? supervise.approveRun(runId) : sub === 'reject' ? supervise.rejectRun(runId) : supervise.statusRun(runId);
          if (!json) note(`${sub}: run ${runId} is ${state.state}`);
          emit({ ok: true, ...state }, { json });
          return 0;
        }
        const result = await supervise.superviseRun({
          planPath: sub,
          runOptions: {
            caseId: str(flags, 'case'),
            platform,
            serial,
            udid,
            app: str(flags, 'app'),
            screenshots: str(flags, 'screenshots') || 'fail',
            useJev: flags.jev !== false,
            jevThreshold: str(flags, 'jev-threshold') || undefined,
            learn: flags.learn !== false,
            runId: str(flags, 'run-id') || undefined,
            maxJevCalls: Number(str(flags, 'max-jev-calls')) || 30,
          },
          agentCmd: str(flags, 'agent-cmd'),
          agentEnvKeep: (str(flags, 'agent-env') || '').split(',').map((name) => name.trim()).filter(Boolean),
          maxRounds: Number(str(flags, 'max-rounds')) || 2,
          resume: flags.resume !== false,
          agentTimeoutMs: (Number(str(flags, 'agent-timeout-min')) || 30) * 60 * 1000,
          actor: flags.agent === true ? 'agent' : 'human',
        });
        if (!json) note(`supervise: run ${result.runId} is ${result.state} (run status: ${result.runStatus}, ${result.rounds} agent round(s), ${result.changed.length} knowledge change(s))`);
        emit({ ok: result.exitCode === 0, runId: result.runId, state: result.state, runStatus: result.runStatus, rounds: result.rounds, changed: result.changed, reportDir: result.reportDir }, { json });
        return result.exitCode;
      }
      case 'hygiene': {
        if (sub === 'scan') {
          const result = require('../hygiene/scan').hygieneScan({
            root: str(flags, 'root') || process.cwd(),
            rulesFiles: (str(flags, 'rules') || '').split(',').map((name) => name.trim()).filter(Boolean),
            useDefaults: flags.defaults !== false,
          });
          if (!json) {
            for (const finding of result.findings) note(`${finding.file}:${finding.line}:${finding.column}  ${finding.rule} — ${finding.description}`);
            note(`hygiene: ${result.findings.length} finding(s) in ${result.scanned} file(s)`);
          }
          emit(json ? result : { ok: result.ok, root: result.root, scanned: result.scanned, count: result.findings.length, byRule: result.byRule, rulesFiles: result.rulesFiles }, { json });
          return result.ok ? 0 : 1;
        }
        break;
      }
      case 'mcp': {
        await require('../mcp/server').startServer();
        // Keep serving: the promise below never resolves, stdin closing ends the process.
        return new Promise(() => {});
      }
      default:
        break;
    }
  } catch (error) {
    note(`reflex: ${error.message || error}`);
    emit({ ok: false, status: 'error', error: error.message || String(error) }, { json: true });
    return 1;
  }
  process.stderr.write(`unknown command: ${[command, sub].filter(Boolean).join(' ')}\n\n${USAGE}\n`);
  emit({ ok: false, status: 'error', error: `unknown command: ${[command, sub].filter(Boolean).join(' ')}` }, { json: true });
  return 1;
}

module.exports = { main, USAGE };
