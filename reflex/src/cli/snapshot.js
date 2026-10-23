/**
 * snapshot.js — what is on the device screen right now, for an agent handling `needs_agent`.
 * Editable fields show only as `text field #N`: on Android their label IS the typed value.
 */
const workspace = require('../util/workspace');
const { visibleTexts, editableNodes } = require('../device/screenState');

function appPackage(appArg, platform) {
  if (!appArg) return null;
  const apps = (workspace.tryRoot() && workspace.manifest().apps) || {};
  const entry = apps[appArg] && apps[appArg][platform];
  if (entry) return entry.package || entry.bundleId || null;
  return appArg;
}

async function snapshot({ platform = 'android', serial, udid, app, createBackend } = {}) {
  const create = createBackend || ((opts) => require('../device/deviceBackend').createDeviceBackend(opts));
  const backend = create({ platform, serial, udid, session: 'reflex-snapshot', appId: appPackage(app, platform) || undefined });
  try {
    const snap = await backend.snapshot();
    const fields = editableNodes(snap);
    const safe = { ...snap, nodes: snap.nodes.filter((node) => !node.editable) };
    return { texts: visibleTexts(safe), fields: fields.map((_, index) => `text field #${index + 1}`), appBundleId: snap.appBundleId || null };
  } finally {
    try { await backend.close(); } catch (_) { /* best effort */ }
  }
}

module.exports = { snapshot };
