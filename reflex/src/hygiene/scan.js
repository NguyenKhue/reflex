/**
 * scan.js — `reflex hygiene scan`: find what must not leave this machine before the project is shared.
 *
 * Generic rules ship with the tool (private IPs, tokens, keys, secret-looking literals, plausible phone numbers); a project adds its own in
 * `hygiene.rules.json` files (internal host names, brand strings) and lists accepted findings under `allow`, each with a reason.
 * A finding NEVER carries the text it matched: a report about secrets must not become the next leak.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = ['node_modules', 'reports', '.agentic', '.git'];
const RULES_FILES = ['hygiene.rules.json', path.join('reflex', 'hygiene.rules.json'), path.join('workspace', 'hygiene.rules.json')];
const MAX_BYTES = 1000000;
const MAX_PER_FILE = 50;

const DEFAULT_RULES = [
  {
    id: 'private-ip',
    description: 'a private IPv4 address',
    regex: '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})\\b',
  },
  {
    id: 'jwt',
    description: 'a JSON web token',
    regex: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}',
  },
  {
    id: 'private-key',
    description: 'a private key block',
    regex: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  },
  {
    id: 'aws-key',
    description: 'an AWS access key id',
    regex: '\\bAKIA[0-9A-Z]{16}\\b',
  },
  {
    id: 'secret-literal',
    description: 'a quoted literal after password / pin / token / api key / secret',
    regex: '["\']?(?:password|passwd|pin|token|api[_-]?key|secret)["\']?\\s*[:=]\\s*["\'][^"\'\\s{<$][^"\']{3,}["\']',
    flags: 'i',
  },
  {
    id: 'vn-phone',
    description: 'a plausible Vietnamese mobile number',
    regex: '\\b0(?:3[2-9]|5[25689]|7[06-9]|8[1-9]|9\\d)\\d{7}\\b',
    ignore: ['^0900000\\d{3}$', '^09(\\d)\\1{8}$'],
  },
];

function compile(rule, where) {
  if (!rule || typeof rule.id !== 'string' || !rule.id) throw new Error(`${where}: every rule needs an id`);
  if (typeof rule.regex !== 'string' || !rule.regex) throw new Error(`${where}: rule "${rule.id}" needs a regex`);
  try {
    const flags = [...new Set(`${rule.flags || ''}g`.split(''))].join('');
    return {
      id: rule.id,
      description: rule.description || rule.id,
      matcher: new RegExp(rule.regex, flags),
      ignore: (rule.ignore || []).map((source) => new RegExp(source)),
    };
  } catch (error) {
    throw new Error(`${where}: rule "${rule.id}" has an invalid regex: ${error.message}`);
  }
}

function loadRulesFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected an object with rules / allow / ignoreDirs`);
  }
  const rules = (parsed.rules || []).map((rule) => compile(rule, file));
  const allow = (parsed.allow || []).map((entry) => {
    if (!entry || typeof entry.file !== 'string' || !entry.file) throw new Error(`${file}: every allow entry needs a file`);
    return { rule: entry.rule || '*', file: entry.file.replace(/\\/g, '/'), reason: entry.reason || '' };
  });
  return { rules, allow, ignoreDirs: Array.isArray(parsed.ignoreDirs) ? parsed.ignoreDirs.map(String) : [] };
}

/** Exact file, or a directory prefix: `reflex/test/` allows everything under it, never a sibling that merely starts the same. */
function isAllowed(allow, ruleId, relative) {
  return allow.some((entry) => {
    if (entry.rule !== '*' && entry.rule !== ruleId) return false;
    const prefix = entry.file.endsWith('/') ? entry.file : `${entry.file}/`;
    return relative === entry.file || relative.startsWith(prefix);
  });
}

function filesOf(root, ignoreDirs) {
  const ignored = new Set(ignoreDirs);
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(root, '');
  return files.sort();
}

function scanTree({ root, rules, allow = [], ignoreDirs = DEFAULT_IGNORE_DIRS, skipFiles = [] }) {
  const skipped = new Set(skipFiles);
  const findings = [];
  let scanned = 0;
  for (const relative of filesOf(root, ignoreDirs)) {
    if (skipped.has(relative)) continue;
    const full = path.join(root, relative);
    let buffer;
    try {
      if (fs.statSync(full).size > MAX_BYTES) continue;
      buffer = fs.readFileSync(full);
    } catch (_) {
      continue;
    }
    if (buffer.subarray(0, 4096).includes(0)) continue;
    scanned += 1;
    let count = 0;
    const lines = buffer.toString('utf8').split('\n');
    for (let index = 0; index < lines.length && count < MAX_PER_FILE; index += 1) {
      for (const rule of rules) {
        for (const match of lines[index].matchAll(rule.matcher)) {
          if (rule.ignore.some((pattern) => pattern.test(match[0]))) continue;
          if (isAllowed(allow, rule.id, relative)) continue;
          findings.push({ rule: rule.id, description: rule.description, file: relative, line: index + 1, column: match.index + 1, length: match[0].length });
          count += 1;
          if (count >= MAX_PER_FILE) break;
        }
        if (count >= MAX_PER_FILE) break;
      }
    }
  }
  return { findings, scanned };
}

function hygieneScan({ root, rulesFiles = [], useDefaults = true } = {}) {
  const base = path.resolve(root || process.cwd());
  const discovered = RULES_FILES.map((name) => path.join(base, name)).filter((file) => fs.existsSync(file));
  const files = [...new Set([...discovered, ...rulesFiles.map((file) => path.resolve(file))])];
  const byId = new Map();
  const allow = [];
  const ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
  if (useDefaults) {
    for (const rule of DEFAULT_RULES) byId.set(rule.id, compile(rule, 'built-in rules'));
  }
  for (const file of files) {
    const loaded = loadRulesFile(file);
    for (const rule of loaded.rules) byId.set(rule.id, rule);
    allow.push(...loaded.allow);
    for (const dir of loaded.ignoreDirs) ignoreDirs.add(dir);
  }
  const relativeFiles = files.map((file) => path.relative(base, file).split(path.sep).join('/'));
  const { findings, scanned } = scanTree({ root: base, rules: [...byId.values()], allow, ignoreDirs: [...ignoreDirs], skipFiles: relativeFiles });
  const byRule = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
  return { ok: findings.length === 0, root: base, scanned, rulesFiles: relativeFiles, rules: [...byId.keys()], findings, byRule };
}

module.exports = { hygieneScan, scanTree, loadRulesFile, DEFAULT_RULES, DEFAULT_IGNORE_DIRS };
