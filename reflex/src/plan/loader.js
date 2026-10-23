/**
 * loader.js — parse an agent-authored `*.plan.md` into a plan object.
 *
 * YAML front-matter holds the plan (goal, inputs, start, flow, verify); the markdown body holds
 * free notes plus the data rows (one table, or an `@data: <file.csv>` line). A plan is a CHAIN
 * OF SCREEN LEGS (`at → to`): how to walk each screen lives in the workspace's `screens/`
 * knowledge base, never here. Structural parsing only: semantic rules live in validate.js.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_OPTIONS = { legTimeoutMs: 60000, maxJevCallsPerLeg: 6, caseWaitMs: 10000, stepTimeoutMs: 120000, unknownGraceMs: 3000 };
const LAUNCH_MODES = ['fresh', 'relaunch', 'attach'];
const DEFAULT_LAUNCH = 'relaunch';
const PLAN_STATUS = ['draft', 'passed'];
const LEG_KEYS = new Set(['at', 'to', 'intent', 'steps', 'checks', 'data', 'sensitive']);

function parseFrontMatter(text, file) {
  // Tolerate a leading BOM and CRLF line endings.
  const source = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) throw new Error(`${file}: missing YAML front-matter (--- … ---) at the top`);
  let meta;
  try {
    meta = yaml.load(match[1]);
  } catch (error) {
    throw new Error(`${file}: invalid YAML front-matter: ${error.message}`);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${file}: front-matter must be a mapping`);
  return { meta, body: source.slice(match[0].length) };
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** First markdown table of the body → row objects keyed by header. */
function parseMarkdownTable(lines) {
  const start = lines.findIndex((line) => line.trim().startsWith('|'));
  if (start < 0) return null;
  const tableLines = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) tableLines.push(lines[i]);
  if (tableLines.length < 2) return null;
  const header = splitRow(tableLines[0]);
  const body = tableLines.slice(1).filter((line) => !/^\|?\s*:?-{2,}/.test(line.trim()));
  return body.map((line) => {
    const cells = splitRow(line);
    return Object.fromEntries(header.map((key, index) => [key, cells[index] === undefined ? '' : cells[index]]));
  });
}

function parseCsv(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    return Object.fromEntries(header.map((key, index) => [key, cells[index] === undefined ? '' : cells[index]]));
  });
}

function readRows(body, file, root) {
  const lines = body.split('\n');
  const dataLine = lines.find((line) => /^@data:\s*\S/.test(line.trim()));
  let rows;
  let fromTable = false;
  if (dataLine) {
    const rel = dataLine.trim().replace(/^@data:\s*/, '');
    const candidates = [path.resolve(path.dirname(file), rel), ...(root ? [path.resolve(root, rel)] : [])];
    const csvFile = candidates.find((candidate) => fs.existsSync(candidate));
    if (!csvFile) throw new Error(`${file}: @data file not found: ${rel}`);
    rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));
  } else {
    rows = parseMarkdownTable(lines);
    fromTable = Boolean(rows);
  }
  if (!rows || !rows.length) return { rows: [{ id: 'default' }], fromTable: false };
  return {
    rows: rows.map((row, index) => ({ ...row, id: row.id ? String(row.id) : `row${index + 1}` })),
    fromTable,
  };
}

function normalizeInputs(inputs, file) {
  if (inputs === undefined || inputs === null) return [];
  if (!Array.isArray(inputs)) throw new Error(`${file}: "inputs" must be a list`);
  return inputs.map((input) => {
    if (typeof input === 'string') return { name: input, required: false, secret: false };
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name) {
      throw new Error(`${file}: every input needs a "name"`);
    }
    return {
      name: input.name,
      required: input.required === true,
      secret: input.secret === true,
      ...(input.default !== undefined ? { default: String(input.default) } : {}),
      ...(input.description ? { description: String(input.description) } : {}),
    };
  });
}

/**
 * `use:` blocks were part of the step plans and are gone. The scan is recursive because a
 * leftover `use` can sit anywhere a step could (a leg's steps, a check, verify).
 */
function hasUse(value) {
  if (Array.isArray(value)) return value.some(hasUse);
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'use')) return true;
    return Object.values(value).some(hasUse);
  }
  return false;
}

/** One leg: where it starts, where it must end, and what is specific to THIS plan's walk. */
function normalizeLeg(leg, file, index) {
  const where = `${file}: flow leg ${index + 1}`;
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
    throw new Error(`${where}: a leg must be a mapping with "at" and "to"`);
  }
  const unknown = Object.keys(leg).filter((key) => !LEG_KEYS.has(key));
  if (unknown.length) throw new Error(`${where}: unknown key(s) ${unknown.join(', ')} (expected ${[...LEG_KEYS].join(' / ')})`);
  for (const key of ['at', 'to']) {
    if (typeof leg[key] !== 'string' || !leg[key].trim()) throw new Error(`${where}: "${key}" must be a screen id "<group>/<screen>"`);
  }
  if (leg.intent !== undefined && (typeof leg.intent !== 'string' || !leg.intent.trim())) {
    throw new Error(`${where}: "intent" must be a non-empty string`);
  }
  for (const key of ['steps', 'checks']) {
    if (leg[key] !== undefined && !Array.isArray(leg[key])) throw new Error(`${where}: "${key}" must be a list of tool steps`);
  }
  if (leg.data !== undefined && (!leg.data || typeof leg.data !== 'object' || Array.isArray(leg.data))) {
    throw new Error(`${where}: "data" must be a mapping of input name → value`);
  }
  if (leg.sensitive !== undefined && typeof leg.sensitive !== 'boolean') {
    throw new Error(`${where}: "sensitive" must be true or false`);
  }
  return {
    at: leg.at,
    to: leg.to,
    ...(leg.intent === undefined ? {} : { intent: leg.intent }),
    ...(leg.steps === undefined ? {} : { steps: leg.steps }),
    ...(leg.checks === undefined ? {} : { checks: leg.checks }),
    ...(leg.data === undefined ? {} : { data: leg.data }),
    ...(leg.sensitive === undefined ? {} : { sensitive: leg.sensitive }),
  };
}

/** `fresh` clears the app; `relaunch` restarts it; `attach` trusts where the app already is. */
function normalizeStart(start, file) {
  const raw = start === undefined || start === null ? {} : start;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: "start" must be a mapping { launch: ${LAUNCH_MODES.join(' | ')} }`);
  }
  const unknown = Object.keys(raw).filter((key) => key !== 'launch');
  if (unknown.length) throw new Error(`${file}: "start" only takes "launch" (got ${unknown.join(', ')})`);
  const launch = raw.launch === undefined || raw.launch === null ? DEFAULT_LAUNCH : raw.launch;
  if (!LAUNCH_MODES.includes(launch)) {
    throw new Error(`${file}: "start.launch" must be one of ${LAUNCH_MODES.join(' / ')} (got "${raw.launch}")`);
  }
  return { launch };
}

function normalizeStatus(status, file) {
  const value = status === undefined || status === null ? 'draft' : status;
  if (!PLAN_STATUS.includes(value)) {
    throw new Error(`${file}: "status" must be one of ${PLAN_STATUS.join(' / ')} (got "${status}")`);
  }
  return value;
}

function loadPlan(file, { root } = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`plan not found: ${abs}`);
  const { meta, body } = parseFrontMatter(fs.readFileSync(abs, 'utf8'), abs);
  if (typeof meta.name !== 'string' || !meta.name) throw new Error(`${abs}: "name" is required`);
  if (meta.steps !== undefined) {
    throw new Error(`${abs}: "steps" plans are no longer supported — rewrite as "flow" legs (see workspace/AGENTS.md)`);
  }
  if (hasUse(meta)) {
    throw new Error(`${abs}: "use:" blocks are no longer supported — put those steps in the screen's normal.yml (see workspace/AGENTS.md)`);
  }
  if (!Array.isArray(meta.flow)) throw new Error(`${abs}: "flow" must be a list of legs ("at" → "to")`);
  const verify = meta.verify === undefined || meta.verify === null ? [] : meta.verify;
  if (!Array.isArray(verify)) throw new Error(`${abs}: "verify" must be a list`);
  const { rows, fromTable } = readRows(body, abs, root);
  return {
    name: meta.name,
    app: meta.app,
    platforms: Array.isArray(meta.platforms) && meta.platforms.length ? meta.platforms.map(String) : ['android'],
    goal: meta.goal,
    request: meta.request || null,
    status: normalizeStatus(meta.status, abs),
    inputs: normalizeInputs(meta.inputs, abs),
    options: { ...DEFAULT_OPTIONS, ...(meta.options && typeof meta.options === 'object' && !Array.isArray(meta.options) ? meta.options : {}) },
    start: normalizeStart(meta.start, abs),
    flow: meta.flow.map((leg, index) => normalizeLeg(leg, abs, index)),
    verify,
    rows,
    rowsFromTable: fromTable,
    file: abs,
  };
}

module.exports = { loadPlan, parseFrontMatter, parseMarkdownTable, parseCsv, DEFAULT_OPTIONS, LAUNCH_MODES, PLAN_STATUS };
