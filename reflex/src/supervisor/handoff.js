/**
 * handoff.js — the document an agent reads when a run stops with `needs_agent`.
 *
 * It is built ONLY from fields that resume.json already holds and that are safe by construction (visible text excludes editable
 * fields, errors are redacted by the runner). Anything else in resume.json (captures, data) is deliberately not copied.
 */
const fs = require('fs');
const path = require('path');

const MAX_TEXT_LINES = 40;
const MAX_LINE = 160;

function clip(text) {
  const value = String(text);
  return value.length > MAX_LINE ? `${value.slice(0, MAX_LINE - 1)}…` : value;
}

function markdownOf(json) {
  const lines = [];
  lines.push(`# Handoff — run ${json.runId}`);
  lines.push('');
  lines.push(`The run of plan \`${json.plan}\` stopped and needs an agent. Created ${json.createdAt}.`);
  lines.push('');
  lines.push('## Where it stopped');
  lines.push(`- Leg ${json.leg.index === null ? '?' : json.leg.index + 1}: \`${json.leg.at}\` → \`${json.leg.to}\`${json.leg.intent ? ` (${json.leg.intent})` : ''}`);
  lines.push(`- Screen identified: ${json.screen ? `\`${json.screen}\`` : '(not identified)'}`);
  lines.push(`- Reason: ${json.reason || '(none)'}${json.error ? ` — ${json.error}` : ''}`);
  lines.push(`- App: ${json.app || '?'} on ${json.platform || '?'}${json.serial ? ` (${json.serial})` : ''}`);
  if (json.screenshot) lines.push(`- Screenshot: ${json.screenshot}`);
  lines.push('');
  lines.push('## What the screen shows (public text only)');
  if (json.visibleText.length) for (const text of json.visibleText) lines.push(`- ${text}`);
  else lines.push('- (nothing readable)');
  lines.push('');
  lines.push('## What you may do');
  lines.push(`- Fix the knowledge of app \`${json.app}\` under \`screens/${json.app}/\`: a missing case in \`normal.yml\`, a wrong \`identify\` in \`screen.md\`, a popup rule in \`exceptions.yml\`.`);
  lines.push('- A real error (a failure message, a rejected transaction) is a `fail` or `blocked` rule, never a dismiss rule.');
  lines.push('');
  lines.push('## What you must not do');
  lines.push('- Never type a password, PIN, OTP or any credential, and never start a run or resume that does.');
  lines.push('- Never edit `screens/_shared/` (policy), a `pinned` item, or the legs of the plan before the stopped one.');
  lines.push('- Never copy a value from the screen into a file; use placeholders such as `{phone}`.');
  lines.push('');
  lines.push('## How to continue');
  if (json.resume.agentMayResume) {
    lines.push(`- After fixing the knowledge, resume with \`${json.resume.command} --agent\` (or the \`resume_start\` MCP tool).`);
  } else {
    const legs = json.resume.sensitiveLegs.map((item) => `${item.index + 1} (${item.reasons.join(', ')})`).join('; ');
    lines.push(`- The rest of this run includes sensitive leg(s): ${legs}.`);
    lines.push(`- Do NOT resume it yourself. Fix the knowledge, then ask the human or CI to run \`${json.resume.command}\`.`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildHandoff({ resume, now = Date.now() } = {}) {
  const source = resume || {};
  const remaining = source.sensitive && Array.isArray(source.sensitive.remaining) ? source.sensitive.remaining : [];
  const blocksAgent = Boolean(source.sensitive && source.sensitive.blocksAgent) || remaining.length > 0;
  const leg = source.leg || {};
  const json = {
    v: 1,
    createdAt: new Date(now).toISOString(),
    runId: source.runId || null,
    plan: source.planName || null,
    planFile: source.plan || null,
    app: source.appKey || null,
    platform: source.platform || null,
    serial: source.serial || null,
    leg: {
      index: Number.isFinite(source.legIndex) ? source.legIndex : null,
      at: leg.at || null,
      to: leg.to || null,
      intent: leg.intent || null,
    },
    screen: source.screen || null,
    reason: source.reason || null,
    error: source.error ? clip(source.error) : null,
    visibleText: (Array.isArray(source.visibleText) ? source.visibleText : []).slice(0, MAX_TEXT_LINES).map(clip),
    screenshot: source.screenshot || null,
    resume: {
      command: `reflex resume ${source.runId}`,
      agentMayResume: !blocksAgent,
      sensitiveLegs: remaining.map((item) => ({ index: item.index, reasons: item.reasons || [] })),
    },
  };
  return { json, markdown: markdownOf(json) };
}

function writeHandoff(reportDir, handoff) {
  const jsonFile = path.join(reportDir, 'handoff.json');
  const markdownFile = path.join(reportDir, 'handoff.md');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(jsonFile, `${JSON.stringify(handoff.json, null, 2)}\n`);
  fs.writeFileSync(markdownFile, `${handoff.markdown}\n`);
  return { jsonFile, markdownFile };
}

module.exports = { buildHandoff, writeHandoff };
