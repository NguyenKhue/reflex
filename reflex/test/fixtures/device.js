/**
 * fixtures.js — inline agent-device snapshots for the jev unit tests.
 *
 * Shapes mirror a live Pixel 5 / Android 14 capture of `com.acme.example`: status-bar
 * nodes carry the systemui bundleId, app nodes may carry none, refs are short ids and
 * the snapshot has a refsGeneration that the pinned ref must include.
 */
const APP = 'com.acme.example';
const SYSTEMUI = 'com.android.systemui';

function node(ref, label, y, overrides = {}) {
  return {
    index: Number(String(ref).replace(/\D/g, '')) || 0,
    ref,
    type: 'android.widget.TextView',
    label,
    value: '',
    bundleId: APP,
    rect: { x: 24, y, width: 320, height: 48 },
    enabled: true,
    selected: false,
    editable: false,
    password: false,
    hintShowing: false,
    visibleToUser: true,
    hittable: true,
    depth: 4,
    parentIndex: 1,
    ...overrides
  };
}

function snapshot(nodes, refsGeneration = 7, extra = {}) {
  return {
    nodes,
    truncated: false,
    visibility: 'full',
    snapshotQuality: { state: 'ok' },
    appBundleId: APP,
    refsGeneration,
    ...extra
  };
}

const statusBar = () => node('e1', '9:41', 12, { bundleId: SYSTEMUI, hittable: false });

/** HARNESS home: a list of green ticks plus one API-contract target. */
function homeRaw() {
  return snapshot([
    statusBar(),
    node('e10', 'Acme Example', 120),
    node('e11', '✓ buildInfo', 180),
    node('e12', '✓ deviceUtils', 230),
    node('e13', '✓ authState', 280),
    node('e14', '✓ api getAvatarEndPoint', 330),
    node('e15', 'max-api-v2', 380),
    node('e16', 'api-contract', 430),
    node('e17', 'Đăng nhập', 500, { type: 'android.widget.Button' })
  ]);
}

/** HARNESS section screen reached after tapping `max-api-v2`. */
function sectionRaw() {
  return snapshot([
    statusBar(),
    node('e30', '‹', 60, { type: 'android.widget.ImageButton' }),
    node('e31', 'max-api-v2', 120, { type: 'androidx.compose.ui.viewinterop.ViewGroup' }),
    node('e32', '▶ Run all', 200, { type: 'android.widget.Button' }),
    node('e33', '0 pass', 260),
    node('e34', 'maxapi.v2 (gốc)', 320)
  ]);
}

/** Login screen: the phone field is pre-filled, so its label is what identifies it. */
function loginRaw() {
  return snapshot([
    statusBar(),
    node('e50', 'Đăng nhập Acme', 100),
    node('e51', 'Số điện thoại', 200, {
      type: 'android.widget.EditText',
      value: '0900000002',
      editable: true,
      focused: true
    }),
    node('e52', 'Huỷ', 300, { type: 'android.widget.Button' }),
    node('e53', 'Tiếp tục', 360, { type: 'android.widget.Button' })
  ]);
}

/** Ranking fixture: an exact match, a longer match, and two y-ordered duplicates. */
function orderingRaw() {
  return snapshot([
    node('e70', 'max-api-v2 gốc', 300),
    node('e71', 'max-api-v2', 400),
    node('e72', 'max-api-v2', 100)
  ]);
}

/** One disabled node that must never become an action. */
function disabledRaw() {
  return snapshot([
    node('e80', 'Bị khoá', 100, { enabled: false }),
    node('e81', 'Bấm được', 160)
  ]);
}

/** A crowded screen used for the state-size trims. */
function longRaw(count = 60) {
  const nodes = [statusBar()];
  for (let index = 0; index < count; index += 1) {
    nodes.push(node(`x${index}`, `dòng ${index} với nội dung dài để buộc phải cắt bớt trạng thái`, 100 + index * 10));
  }
  return snapshot(nodes);
}

/** A series of distinct screens, for the step-budget test. */
function scrollingRaw(count = 6) {
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(snapshot([
      statusBar(),
      node(`s${index}`, `trang ${index}`, 200),
      node(`t${index}`, 'Đăng nhập', 300, { type: 'android.widget.Button' })
    ], 7 + index));
  }
  return frames;
}

module.exports = {
  APP,
  SYSTEMUI,
  node,
  snapshot,
  homeRaw,
  sectionRaw,
  loginRaw,
  orderingRaw,
  disabledRaw,
  longRaw,
  scrollingRaw
};
