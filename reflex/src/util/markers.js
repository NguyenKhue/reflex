/**
 * markers.js — the single machine-readable stdout marker: `REFLEX_JSON <one-line json>`.
 */
const MARKER = 'REFLEX_JSON';

function parseMarker(line) {
  const text = String(line || '');
  if (!text.startsWith(`${MARKER} `)) return null;
  try {
    return JSON.parse(text.slice(MARKER.length + 1));
  } catch (_) {
    return null;
  }
}

module.exports = { MARKER, parseMarker };
