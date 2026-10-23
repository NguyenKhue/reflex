/**
 * status.js — `<reportDir>/status.json`, the run's live state. MCP `run_status` and agents
 * polling a detached run read it; writes are atomic so a reader never sees half a file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function statusFile(reportDir) {
  return path.join(reportDir, 'status.json');
}

function readStatus(reportDir) {
  const file = statusFile(reportDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeStatus(reportDir, patch) {
  fs.mkdirSync(reportDir, { recursive: true });
  const next = { ...(readStatus(reportDir) || {}), ...patch, updatedAt: new Date().toISOString() };
  const file = statusFile(reportDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

/** Key-order independent JSON, so a re-saved plan with reordered keys hashes the same. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function stableHash(value) {
  return crypto.createHash('sha1').update(stableStringify(value)).digest('hex');
}

module.exports = { readStatus, writeStatus, stableHash, stableStringify };
