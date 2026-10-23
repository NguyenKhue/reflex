/**
 * uiautomator.js — read the screen through `adb shell uiautomator dump`, for the windows agent-device cannot see.
 *
 * agent-device snapshots the foreground APP; a system window in front of it (the share sheet, a permission dialog, a picker)
 * makes it fail with "insufficient foreground app content". `uiautomator dump` lists every window, so the device backend uses it
 * as a fallback, and only then. The result has the same node shape as `normalizeSnapshot`, with two differences a caller can
 * rely on: nodes have no ref (a press goes by the centre of the node's rect) and the snapshot says `source: 'uiautomator'`.
 *
 * No XML library: the dump is a flat list of `<node .../>` tags with simple attributes.
 */
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function unescapeXml(value) {
  return String(value)
    .replace(/&(amp|lt|gt|quot|apos);/g, (match) => ENTITIES[match])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function attributesOf(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) attributes[match[1]] = unescapeXml(match[2]);
  return attributes;
}

/** "[l,t][r,b]" -> { x, y, width, height }, or null when it is not a usable box. */
function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value || ''));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * `parseUiautomatorDump(xml, { ignorePackages, now })` -> a normalised snapshot. Nodes that say nothing (no text,
 * description or resource id) and nodes of `ignorePackages` (the status bar) are dropped. Never throws: garbage in, no nodes out.
 */
function parseUiautomatorDump(xml, { ignorePackages = ['com.android.systemui'], now = Date.now() } = {}) {
  const nodes = [];
  for (const match of String(xml || '').matchAll(/<node\b[^>]*>/g)) {
    const attributes = attributesOf(match[0]);
    if (ignorePackages.includes(attributes.package)) continue;
    const rect = parseBounds(attributes.bounds);
    const label = attributes.text || attributes['content-desc'] || '';
    const identifier = attributes['resource-id'] || null;
    if (!rect || (!label && !identifier)) continue;
    nodes.push({
      ref: null,
      pinned: null,
      type: attributes.class || '',
      role: String(attributes.class || '').split('.').pop().toLowerCase(),
      label,
      value: '',
      text: label.trim(),
      identifier,
      rect,
      enabled: attributes.enabled !== 'false',
      hittable: attributes.clickable === 'true',
      editable: /EditText/.test(attributes.class || ''),
      focused: attributes.focused === 'true',
      password: attributes.password === 'true',
      hintShowing: false,
    });
  }
  return {
    generation: undefined,
    truncated: false,
    sparse: false,
    appBundleId: null,
    takenAt: now,
    source: 'uiautomator',
    nodes,
  };
}

module.exports = { parseUiautomatorDump, parseBounds, unescapeXml };
