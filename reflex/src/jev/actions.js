/**
 * actions.js — the closed set of actions offered to Jev for one screen.
 *
 * Jev can only answer with one of these ids, which keeps the decision typed and
 * auditable: every id maps to exactly one backend call. Action descriptions never
 * carry input VALUES (they can be secrets) — only input names.
 */
const { foldText, publicText, editableNodes, fieldName } = require('../device/screenState');

/** The explore verdicts; a caller with its own stop conditions (a plan leg) replaces them. */
const DEFAULT_VERDICTS = [
  {
    id: 'qa_pass',
    kind: 'verdict',
    verdict: 'pass',
    description: 'The task is complete and the current screen visibly shows every expected outcome'
  },
  {
    id: 'qa_fail',
    kind: 'verdict',
    verdict: 'fail',
    description: 'The current screen clearly shows the expectation is violated: an error message or a wrong final state'
  },
  {
    id: 'need_input',
    kind: 'verdict',
    verdict: 'need_input',
    description: 'The task requires a value that is not among the provided inputs'
  },
  {
    id: 'incomplete',
    kind: 'verdict',
    verdict: 'incomplete',
    description: 'No available action can make progress toward the task'
  }
];

/** Actions that are always available, before any screen content is considered. */
function fixedActions({ allowBack, allowScroll, verdicts = DEFAULT_VERDICTS }) {
  const actions = [
    ...verdicts.map((item) => ({ id: item.id, kind: 'verdict', verdict: item.verdict, description: item.description })),
    { id: 'wait', kind: 'wait', description: 'Wait for loading content to appear' }
  ];
  if (allowBack) {
    actions.push({ id: 'back', kind: 'back', description: 'Press the system back button (may leave the app)' });
  }
  if (allowScroll) {
    actions.push({ id: 'scroll_down', kind: 'scroll', direction: 'down', description: 'Scroll down' });
    actions.push({ id: 'scroll_up', kind: 'scroll', direction: 'up', description: 'Scroll up' });
  }
  return actions;
}

function byScreenOrder(a, b) {
  const ay = a.rect && Number(a.rect.y);
  const by = b.rect && Number(b.rect.y);
  if (!Number.isFinite(ay)) return Number.isFinite(by) ? 1 : 0;
  if (!Number.isFinite(by)) return -1;
  return ay - by;
}

/**
 * Every action the agent may take on this screen. Press actions come top-to-bottom;
 * one fill action per (editable field × input name).
 */
function buildActions(snapshot, { inputs = [], allowBack = true, allowScroll = true, maxActions = 255, verdicts } = {}) {
  const fixed = fixedActions({ allowBack, allowScroll, verdicts });
  const fields = editableNodes(snapshot);
  const nodes = ((snapshot && snapshot.nodes) || [])
    .filter((node) => (publicText(node) || node.editable) && node.enabled !== false)
    .slice()
    .sort(byScreenOrder);

  const seen = new Set();
  const candidates = [];
  for (const node of nodes) {
    const key = node.editable ? `field|${node.ref}` : `${foldText(node.text)}|${node.type || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(node);
  }

  const label = (node) => (node.editable ? fieldName(fields.indexOf(node)) : `"${publicText(node)}"`);
  const presses = candidates.map((node, index) => ({
    id: `p${node.ref || index}`,
    kind: 'press',
    node,
    ...(node.editable ? { fieldIndex: fields.indexOf(node) } : {}),
    description: `Tap ${label(node)}`
  }));

  const names = (Array.isArray(inputs) ? inputs : [])
    .map((input) => (typeof input === 'string' ? input : input && input.name))
    .filter((name) => typeof name === 'string' && name);
  const fills = [];
  for (const node of candidates) {
    if (!node.editable) continue;
    for (const name of names) {
      fills.push({
        id: `f${node.ref || 'field'}_${name}`,
        kind: 'fill',
        node,
        input: name,
        fieldIndex: fields.indexOf(node),
        description: `Type the input "${name}" into ${label(node)}`
      });
    }
  }

  const room = Math.max(0, maxActions - fixed.length);
  return [...fixed, ...[...presses, ...fills].slice(0, room)];
}

/** Short, secret-free label for traces and reports. */
function describeAction(action) {
  if (!action) return 'unknown';
  switch (action.kind) {
    case 'press':
      return action.fieldIndex !== undefined ? `press ${fieldName(action.fieldIndex)}` : `press "${publicText(action.node)}"`;
    case 'fill':
      return `fill "${action.input}" into ${fieldName(action.fieldIndex || 0)}`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'wait':
      return 'wait';
    case 'back':
      return 'back';
    case 'verdict':
      return `verdict ${action.verdict}`;
    default:
      return String(action.kind || 'unknown');
  }
}

module.exports = { buildActions, describeAction, DEFAULT_VERDICTS };
