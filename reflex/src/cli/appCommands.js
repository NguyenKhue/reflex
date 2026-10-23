/**
 * appCommands.js — `reflex app init`: register a new app in the workspace so a plan can name it.
 *
 * It writes only what is app-specific and safe to commit: the manifest entry (package / activity / bundle id) and the
 * `screens/<key>/_app/` notes. It never touches an existing app and never writes a credential. Everything is validated
 * before the first write, and the manifest is written LAST, so a failure cannot leave a half-registered app behind.
 */
const fs = require('fs');
const path = require('path');
const workspace = require('../util/workspace');

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DOTTED_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MANIFEST_NAMES = ['reflex.workspace.json'];

function contextTemplate(key) {
  return [
    `# ${key} — notes`,
    '',
    'Notes for the people and the decider working on this app. Keep it short and factual.',
    '',
    '- What the app is and how a test starts (signed in? onboarding? a fresh install?).',
    '- How elements are found: visible text, test ids (btn_...), content descriptions.',
    '- Popups and errors this app shows: which are harmless (dismiss) and which are real failures (fail / blocked).',
    '- Slow screens and how long they take (waitMs).',
    '',
  ].join('\n');
}

function manifestFileOf(root) {
  const name = MANIFEST_NAMES.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (!name) throw new Error(`${root} has no ${MANIFEST_NAMES.join(' or ')}`);
  return name;
}

function checkId(value) {
  if (!DOTTED_ID.test(String(value))) {
    throw new Error(`"${value}" is not a valid package / bundle id (expected dotted names such as com.example.app)`);
  }
}

function appInit({ key, package: appPackage = null, activity = null, bundleId = null, root = null } = {}) {
  if (!key || !KEY.test(String(key))) {
    throw new Error(`app init requires an app key: lowercase letters, digits and underscores, starting with a letter (got "${key || ''}")`);
  }
  if (!appPackage && !bundleId) throw new Error('app init requires --package <android package> and/or --bundle-id <ios bundle id>');
  if (appPackage) checkId(appPackage);
  if (bundleId) checkId(bundleId);

  const base = root || workspace.root();
  const manifestName = manifestFileOf(base);
  const manifestFile = path.join(base, manifestName);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestName} is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${manifestName} is not valid JSON: expected an object`);
  const apps = manifest.apps && typeof manifest.apps === 'object' ? manifest.apps : {};
  if (apps[key]) throw new Error(`app "${key}" is already in ${manifestName}`);
  const appDir = path.join(base, 'screens', key);
  if (fs.existsSync(appDir)) throw new Error(`${path.join('screens', key)} already exists`);

  const entry = {};
  if (appPackage) entry.android = activity ? { package: appPackage, activity } : { package: appPackage };
  if (bundleId) entry.ios = { bundleId };

  const files = {
    [path.join('screens', key, '_app', 'context.md')]: contextTemplate(key),
    [path.join('screens', key, '_app', 'exceptions.yml')]: '[]\n',
    [path.join('screens', key, '_app', 'routes.yml')]: '[]\n',
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  manifest.apps = { ...apps, [key]: entry };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, app: key, manifest: manifestName, created: Object.keys(files) };
}

module.exports = { appInit };
