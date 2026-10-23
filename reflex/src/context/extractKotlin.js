/**
 * extractKotlin.js — what an app's screens can show, read from Kotlin / Compose source.
 *
 * A small tokenizer, not a parser: it masks comments and string contents (so braces and regexes
 * only ever see code), then reads
 *   - screens: @Composable functions named *Screen / *Popup / *Dialog(s) / *Section / *Tab / *Panel,
 *   - texts:   string literals passed as call arguments or parameter defaults inside composables,
 *              plus enum `label = "…"` values referenced by a screen,
 *   - actions: `showing(Enum.X)` / `onRun(Enum.X)` inside a screen (navigation is state-driven),
 *   - extras:  `getStringExtra("…")` and `const val EXTRA_* = "…"`.
 * Best effort by design: a missed text only makes Jev's hint shorter, never wrong.
 */
const fs = require('fs');
const path = require('path');

const SCREEN_NAME = /(Screen|Popup|Dialog|Dialogs|Section|Tab|Panel)$/;
const NOT_SCREEN = /(Theme|Components|Instrumentation)$/;
const NOISE_LINE = /\b(Log\.|println|logcat|error\(|require\(|check\(|TAG\b)/;
const MIN_LEN = 2;
const MAX_LEN = 60;
const SYMBOLS_OK = /[‹›▸▶✓✕⟳]/;

function listKotlinFiles(src) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['build', 'test', 'node_modules'].includes(entry.name) || /Test$/.test(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith('.kt') && !/Test/.test(entry.name)) {
        const rel = full.split(path.sep).join('/');
        if (/\/src\/(commonMain|androidMain)\//.test(rel)) out.push(full);
      }
    }
  };
  walk(src);
  return out.sort();
}

/**
 * Mask comments and string contents with spaces (positions preserved) and collect every
 * string literal: `{ start, end, raw }` where start/end index the quotes.
 */
function tokenize(text) {
  const masked = text.split('');
  const literals = [];
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (masked[i] !== '\n') masked[i] = ' ';
  };

  function scanString(start) {
    // text[start] === '"'; returns the index just after the closing quote.
    let i = start + 1;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') return i + 1;
      if (c === '$' && text[i + 1] === '{') {
        i = scanTemplate(i + 2);
        continue;
      }
      if (c === '\n') return i; // unterminated: stop at the line end
      i += 1;
    }
    return i;
  }

  function scanTemplate(i) {
    // Inside `${ … }`: nested braces and nested strings.
    let depth = 1;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '"') { i = scanString(i); continue; }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    return i;
  }

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' && text.startsWith('"""', i)) {
      // Raw strings are code samples / SQL / JSON in this codebase, never UI copy.
      const end = text.indexOf('"""', i + 3);
      const stop = end < 0 ? text.length : end + 3;
      blank(i, stop);
      i = stop;
    } else if (c === '"') {
      const end = scanString(i);
      literals.push({ start: i, end, raw: text.slice(i + 1, Math.max(i + 1, end - 1)) });
      blank(i + 1, end - 1);
      i = end;
    } else if (c === '\'') {
      // Char literal: '"' must not open a string.
      const end = text[i + 1] === '\\' ? text.indexOf('\'', i + 3) : text.indexOf('\'', i + 2);
      const stop = end < 0 ? i + 1 : end + 1;
      blank(i + 1, stop - 1);
      i = stop;
    } else {
      i += 1;
    }
  }
  return { masked: masked.join(''), literals };
}

/** Visible value of a literal: unescaped, cut at the first template, or null when it is noise. */
function literalText(raw) {
  let value = '';
  let templated = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === 'u') {
        value += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 5;
      } else {
        value += { n: '\n', t: '\t', r: '', b: '' }[n] ?? n;
        i += 1;
      }
    } else if (c === '$' && /[{A-Za-z_]/.test(raw[i + 1] || '')) {
      templated = true;
      break;
    } else {
      value += c;
    }
  }
  value = value.replace(/\s+/g, ' ').trim();
  // A short static head of a template ("Bước ${n}") is a fragment, not something to look for.
  if (templated && value.length < 5) return null;
  if (value.length < MIN_LEN || value.length > MAX_LEN) return null;
  if (/[%\\]/.test(value) || /\n/.test(value)) return null;
  if (!/[\p{L}\p{N}]/u.test(value) && !SYMBOLS_OK.test(value)) return null;
  // Identifiers, keys and routes (`auth_state`, `com.acme.x`, `a/b`) are not UI copy.
  if (/^[a-z][A-Za-z0-9]*[_.][A-Za-z0-9_.]+$/.test(value) || /^[\w.-]+\/[\w./-]+$/.test(value)) return null;
  return value;
}

function matchClose(masked, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

/** Is the literal at `start` a call argument / default value / assignment (not a `when` key)? */
function isArgument(masked, start) {
  let i = start - 1;
  while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  const prev = masked[i];
  if (prev === '(' || prev === ',' || prev === '=' || prev === '+') return true;
  return prev === '>' && masked[i - 1] === '-'; // `"KEY" -> "visible text"`
}

function findComposables(masked) {
  const out = [];
  const re = /@Composable\s+(?:(?:private|internal|public|inline|override)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Z]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const name = m[1];
    const paramsOpen = m.index + m[0].length - 1;
    const paramsClose = matchClose(masked, paramsOpen, '(', ')');
    let j = paramsClose + 1;
    while (j < masked.length && /\s/.test(masked[j])) j += 1;
    if (masked[j] === ':') {
      // A return type: skip to the body brace or an expression body.
      while (j < masked.length && masked[j] !== '{' && masked[j] !== '=') j += 1;
    }
    if (masked[j] !== '{') continue; // expression-bodied composables are rare wrappers
    const bodyClose = matchClose(masked, j, '{', '}');
    out.push({ name, start: m.index, paramsOpen, bodyOpen: j, end: bodyClose });
    re.lastIndex = bodyClose;
  }
  return out;
}

function findEnums(masked, literals, text) {
  const enums = [];
  const re = /enum\s+class\s+(\w+)[^{]*\{/g;
  let m;
  while ((m = re.exec(masked))) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open, '{', '}');
    const semi = masked.indexOf(';', open);
    const entriesEnd = semi > 0 && semi < close ? semi : close;
    const entryRe = /\b([A-Z][A-Z0-9_]*)\s*\(/g;
    entryRe.lastIndex = open + 1;
    let e;
    while ((e = entryRe.exec(masked)) && e.index < entriesEnd) {
      const argsOpen = e.index + e[0].length - 1;
      const argsClose = matchClose(masked, argsOpen, '(', ')');
      const labelMatch = /\blabel\s*=\s*"/.exec(masked.slice(argsOpen, argsClose));
      if (labelMatch) {
        const quote = argsOpen + labelMatch.index + labelMatch[0].length - 1;
        const literal = literals.find((item) => item.start === quote);
        const label = literal ? literalText(literal.raw) : null;
        if (label) enums.push({ enum: name, entry: e[1], label });
      }
      entryRe.lastIndex = argsClose + 1;
    }
    re.lastIndex = close;
  }
  return enums;
}

function pascal(entry) {
  return entry.toLowerCase().split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function extractKotlin({ src }) {
  const root = path.resolve(src);
  const files = listKotlinFiles(root).map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return { file, rel: path.relative(root, file).split(path.sep).join('/'), text, ...tokenize(text) };
  });

  const enums = files.flatMap((f) => findEnums(f.masked, f.literals, f.text));
  const screens = [];
  const shared = [];
  const bodies = [];

  for (const f of files) {
    const composables = findComposables(f.masked);
    const base = path.basename(f.file, '.kt');
    const fileScreen = composables.find((c) => c.name === base && SCREEN_NAME.test(c.name) && !NOT_SCREEN.test(c.name));
    const isScreen = (c) => SCREEN_NAME.test(c.name) && !NOT_SCREEN.test(c.name);
    // Owners first, so a helper declared above its file screen still lands on that screen.
    const byName = new Map();
    for (const c of composables.filter(isScreen)) {
      if (byName.has(c.name)) continue;
      const owner = { id: c.name, file: f.rel, texts: [], actions: [] };
      byName.set(c.name, owner);
      screens.push(owner);
    }
    let fileOwner = fileScreen ? byName.get(fileScreen.name) : null;
    if (!fileOwner && SCREEN_NAME.test(base) && !NOT_SCREEN.test(base) && composables.length) {
      // `SessionSection.kt` builds its section in a non-composable (`LazyListScope.sessionSection`):
      // the file itself is the screen, and its helper composables are its parts.
      fileOwner = { id: base, file: f.rel, texts: [], actions: [] };
      screens.push(fileOwner);
      bodies.push({ owner: fileOwner, masked: f.masked, literals: f.literals.map((l) => ({ ...l, rel: l.start })) });
    }
    for (const c of composables) {
      const owner = isScreen(c) ? byName.get(c.name) : fileOwner;
      if (isScreen(c)) {
        bodies.push({
          owner,
          masked: f.masked.slice(c.bodyOpen, c.end),
          literals: f.literals.filter((l) => l.start > c.bodyOpen && l.start < c.end).map((l) => ({ ...l, rel: l.start - c.bodyOpen })),
        });
      }
      const target = owner ? owner.texts : shared;
      for (const literal of f.literals) {
        if (literal.start < c.paramsOpen || literal.start > c.end) continue;
        if (!isArgument(f.masked, literal.start)) continue;
        if (NOISE_LINE.test(lineAt(f.text, literal.start))) continue;
        pushUnique(target, literalText(literal.raw));
      }
    }
  }

  const screenIds = new Set(screens.map((screen) => screen.id));
  const referenced = new Set();
  for (const { owner, masked, literals } of bodies) {
    for (const item of enums) {
      if (new RegExp(`\\b${item.enum}\\.${item.entry}\\b`).test(masked)) {
        pushUnique(owner.texts, item.label);
        referenced.add(`${item.enum}.${item.entry}`);
      }
    }
    const actionRe = /\b(showing|onRun)\(\s*(\w+)\.([A-Z][A-Z0-9_]*)\s*\)/g;
    let m;
    while ((m = actionRe.exec(masked))) {
      const [, , enumName, entry] = m;
      const suffixes = ['Screen', 'Popup', 'Dialog', 'Section', 'Tab', 'Panel'];
      const to = suffixes.map((suffix) => `${pascal(entry)}${suffix}`).find((id) => screenIds.has(id)) || `${enumName}.${entry}`;
      const enumLabel = enums.find((item) => item.enum === enumName && item.entry === entry);
      let label = enumLabel ? enumLabel.label : null;
      if (!label) {
        const before = literals.filter((l) => l.rel < m.index && l.rel > m.index - 300).map((l) => literalText(l.raw)).filter((value) => value && owner.texts.includes(value));
        label = before.length ? before[before.length - 1] : null;
      }
      if (!owner.actions.some((action) => action.to === to && action.label === label)) owner.actions.push({ label, to });
    }
  }
  for (const item of enums) {
    if (!referenced.has(`${item.enum}.${item.entry}`)) pushUnique(shared, item.label);
  }

  const extras = new Set();
  for (const f of files) {
    for (const m of f.text.matchAll(/getStringExtra\(\s*"([^"]+)"\s*\)/g)) extras.add(m[1]);
    for (const m of f.text.matchAll(/const\s+val\s+EXTRA_\w+\s*=\s*"([^"]+)"/g)) extras.add(m[1]);
  }

  return {
    screens: screens.filter((screen) => screen.texts.length || screen.actions.length),
    shared,
    enums,
    extras: [...extras].sort(),
  };
}

module.exports = { extractKotlin, tokenize, literalText };
