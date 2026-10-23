/**
 * knowledgeSnapshot.js — keep an agent's knowledge edits provisional.
 *
 * Before an agent works on a stuck run the app's screens (and the shared policy tier) are copied away; afterwards the two trees are diffed so a
 * human can read exactly what changed, approve it (drop the snapshot) or reject it (restore the snapshot byte for byte). Changes under `_shared`
 * are policy and always forbidden. There is no git in this repo, so this is file based; the `diff` binary (BSD/GNU `-u --label`) renders the text.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SHARED = '_shared';

function namesOf(app) {
  return [String(app), SHARED];
}

function filesOf(dir) {
  const files = [];
  const walk = (current, prefix) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(dir, '');
  return files.sort();
}

function sameContent(a, b) {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** `diff -u` exits 1 when the files differ, which execFileSync reports as an error carrying the output. */
function unified(before, after, label) {
  try {
    return execFileSync('diff', ['-u', '--label', `before/${label}`, '--label', `after/${label}`, before, after], { encoding: 'utf8' });
  } catch (error) {
    if (error && error.status === 1 && typeof error.stdout === 'string') return error.stdout;
    return `(diff unavailable for ${label}: ${(error && error.message) || error})\n`;
  }
}

function snapshotKnowledge(root, app, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of namesOf(app)) {
    const from = path.join(root, 'screens', name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, name), { recursive: true });
  }
  return dest;
}

function diffKnowledge(root, app, snapshotDir) {
  const changed = [];
  const parts = [];
  for (const name of namesOf(app)) {
    const liveDir = path.join(root, 'screens', name);
    const thenDir = path.join(snapshotDir, name);
    const live = new Set(filesOf(liveDir));
    const then = new Set(filesOf(thenDir));
    for (const relative of [...new Set([...live, ...then])].sort()) {
      const file = `screens/${name}/${relative}`;
      const liveFile = path.join(liveDir, relative);
      const thenFile = path.join(thenDir, relative);
      let kind = null;
      if (!then.has(relative)) kind = 'added';
      else if (!live.has(relative)) kind = 'removed';
      else if (!sameContent(thenFile, liveFile)) kind = 'modified';
      if (!kind) continue;
      changed.push({ file, kind, forbidden: name === SHARED });
      parts.push(unified(kind === 'added' ? '/dev/null' : thenFile, kind === 'removed' ? '/dev/null' : liveFile, file));
    }
  }
  changed.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { changed, forbidden: changed.filter((item) => item.forbidden), diffText: parts.join('') };
}

function restoreKnowledge(root, app, snapshotDir) {
  for (const name of namesOf(app)) {
    const liveDir = path.join(root, 'screens', name);
    const thenDir = path.join(snapshotDir, name);
    fs.rmSync(liveDir, { recursive: true, force: true });
    if (fs.existsSync(thenDir)) fs.cpSync(thenDir, liveDir, { recursive: true });
  }
}

module.exports = { snapshotKnowledge, diffKnowledge, restoreKnowledge };
