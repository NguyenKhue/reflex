/**
 * screens.js — a tiny state-machine device for runner tests: named screens, and presses that
 * move between them. Snapshots go through the real normalizeSnapshot, so every higher layer
 * (findNodes, buildActions, toJevState) sees exactly what it sees on a device.
 */
const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const fixtures = require('./device');

const APP = fixtures.APP;

/** `screens`: { name: [label | { label, editable, identifier }] }; `moves`: { name: { label|identifier: nextScreen } }. */
function createScreenDevice({ screens, moves = {}, start, appId = APP, hidden = {} }) {
  let current = start;
  const log = [];
  const fills = [];
  // Typed text per field ref: a device shows it as the field's label, and `fill` reads it back.
  const typed = new Map();
  let closed = 0;

  // `hidden`: { screen: [labels] } are nodes only the raw tree lists (a collapsed "helper" node on Android).
  function raw(withHidden = false) {
    const labels = [...(screens[current] || []), ...(withHidden ? hidden[current] || [] : [])];
    return fixtures.snapshot(labels.map((item, index) => {
      const spec = typeof item === 'string' ? { label: item } : item;
      const ref = `${current}${index}`;
      const shown = spec.editable && typed.has(ref);
      return fixtures.node(ref, shown ? typed.get(ref) : spec.label, 100 + index * 60, {
        // A test ID travels as `identifier` (the fixture node keeps it through normalizeSnapshot).
        ...(spec.identifier ? { identifier: spec.identifier } : {}),
        ...(spec.editable ? { type: 'android.widget.EditText', editable: true, hintShowing: !shown } : {}),
      });
    }), 7, { appBundleId: appId });
  }

  const backend = {
    log,
    fills,
    get screen() { return current; },
    set screen(name) { current = name; },
    get closed() { return closed; },
    async open(args) { log.push({ kind: 'open', ...args }); return { ok: true, app: appId }; },
    // `start.launch: fresh` wipes the app on a device; here the test decides where it starts.
    async resetApp() { log.push({ kind: 'reset' }); return { ok: true }; },
    async snapshot({ raw: wantRaw = false } = {}) { return normalizeSnapshot(raw(!!wantRaw), appId); },
    async press(node) {
      log.push({ kind: 'press', label: node.text });
      const table = moves[current] || {};
      // A press may be described by its visible label or by its test id (a launch pad for RN).
      const next = table[node.text] !== undefined ? table[node.text] : table[node.identifier];
      if (next) current = next;
      return { ok: true };
    },
    async fill(node, text) {
      fills.push(text);
      typed.set(node.ref, String(text));
      log.push({ kind: 'fill', field: node.ref });
      return { ok: true };
    },
    async scroll(direction) { log.push({ kind: 'scroll', direction }); return { ok: true }; },
    async back() {
      log.push({ kind: 'back' });
      const next = (moves[current] || {}).__back;
      if (next) current = next;
      return { ok: true };
    },
    async screenshot(file) { log.push({ kind: 'screenshot' }); return file; },
    async close() { closed += 1; },
    async clearLogcat() { return { ok: true }; },
    async readLogcat() { return ''; },
    meta() { return { backend: 'screens', platform: 'android', appId }; },
  };
  return backend;
}

/** A mock Jev responder that taps the action whose description matches, then declares done. */
function chooseByDescription(description) {
  return (state, questions) => {
    const criteria = questions.nextAction.criteria;
    const id = Object.keys(criteria).find((key) => criteria[key] === description);
    return { nextAction: { choice: id || 'blocked', confidence: 0.9 } };
  };
}

module.exports = { createScreenDevice, chooseByDescription, APP };
