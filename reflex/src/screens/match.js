const { foldText, visibleTexts } = require('../device/screenState');

const KEYS = ['anyId', 'allText', 'anyText', 'noneText'];

/** Folded public texts + identifiers of a snapshot, computed once per snapshot. */
function screenIndex(snapshot) {
  const texts = visibleTexts(snapshot).map(foldText);
  const ids = new Set();
  for (const node of (snapshot && snapshot.nodes) || []) {
    if (node.identifier) ids.add(foldText(node.identifier));
    // RN test IDs often surface as a node text (e.g. "btn_continue"), not as `identifier`.
    if (!node.editable && /^[a-z][A-Za-z0-9_.\/-]*$/.test(String(node.text || ''))) ids.add(foldText(node.text));
  }
  return { texts, ids };
}

const has = (index, wanted) => { const w = foldText(wanted); return index.texts.some((t) => t.includes(w)); };

/** True when every condition present holds; a `when` with no condition never matches. */
function matchWhen(index, when) {
  if (!when || !KEYS.some((key) => Array.isArray(when[key]) && when[key].length)) return false;
  if (when.anyId && !when.anyId.some((id) => index.ids.has(foldText(id)))) return false;
  if (when.allText && !when.allText.every((t) => has(index, t))) return false;
  if (when.anyText && !when.anyText.some((t) => has(index, t))) return false;
  if (when.noneText && when.noneText.some((t) => has(index, t))) return false;
  return true;
}

/** Number of conditions — the tie-breaker when several screens match. */
function specificity(when) {
  return KEYS.reduce((n, key) => n + (Array.isArray(when && when[key]) ? when[key].length : 0), 0);
}

module.exports = { screenIndex, matchWhen, specificity, KEYS };
