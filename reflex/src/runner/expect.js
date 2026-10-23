/**
 * expect.js — a step's deterministic post-condition. It is the success test of L0 and the
 * stop condition of L2: Jev saying "done" is never enough on its own.
 */
const KINDS = ['text', 'anyText', 'absent', 'logcat'];

function validateExpect(expect) {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) throw new Error('"expect" must be a mapping');
  const kinds = KINDS.filter((kind) => expect[kind] !== undefined);
  if (kinds.length !== 1) throw new Error(`"expect" needs exactly one of ${KINDS.join(' / ')}`);
  const [kind] = kinds;
  const extra = Object.keys(expect).filter((key) => !KINDS.includes(key) && key !== 'timeout' && key !== 'exact');
  if (extra.length) throw new Error(`"expect" has unknown key(s): ${extra.join(', ')}`);
  if (expect.timeout !== undefined && !(Number(expect.timeout) >= 0)) {
    // A placeholder like "{runTimeoutMs}" is a number only after interpolation.
    if (!/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(expect.timeout))) throw new Error('"expect.timeout" must be a number of ms');
  }
  if (expect.exact !== undefined && typeof expect.exact !== 'boolean') throw new Error('"expect.exact" must be true/false');
  if (kind === 'anyText') {
    if (!Array.isArray(expect.anyText) || !expect.anyText.length || expect.anyText.some((item) => typeof item !== 'string' || !item)) {
      throw new Error('"expect.anyText" must be a non-empty list of texts');
    }
  } else if (typeof expect[kind] !== 'string' || !expect[kind]) {
    throw new Error(`"expect.${kind}" must be a non-empty string`);
  }
  if (kind === 'logcat') {
    try {
      new RegExp(expect.logcat);
    } catch (error) {
      throw new Error(`"expect.logcat" is not a valid regexp: ${error.message}`);
    }
  }
}

function timeoutOf(expect, defaultTimeout) {
  const value = Number(expect.timeout);
  return Number.isFinite(value) && value >= 0 ? value : defaultTimeout;
}

async function checkExpect(session, expect, { defaultTimeout = 8000 } = {}) {
  const timeout = timeoutOf(expect, defaultTimeout);
  const exact = expect.exact === true;
  try {
    let result;
    let seen;
    if (expect.text !== undefined) {
      result = await session.wait_text({ text: expect.text, exact, timeout });
      seen = `saw "${expect.text}"`;
    } else if (expect.anyText !== undefined) {
      result = await session.wait_any_text({ texts: expect.anyText, timeout });
      seen = `saw "${(result && (result.matched || result.value)) || expect.anyText[0]}"`;
    } else if (expect.absent !== undefined) {
      result = await session.assert_absent({ text: expect.absent, exact, timeout });
      seen = `"${expect.absent}" is gone`;
    } else {
      result = await session.expect_logcat({ pattern: expect.logcat, timeout });
      seen = `logcat matched /${expect.logcat}/`;
    }
    const ok = Boolean(result) && result.ok !== false && result.found !== false;
    return { ok, detail: ok ? seen : `expect not met after ${timeout}ms: ${describeExpect(expect)}` };
  } catch (error) {
    return { ok: false, detail: `expect check failed: ${error.message || error}` };
  }
}

/** English phrasing for Jev's `doneWhen`. */
function describeExpect(expect) {
  if (!expect) return null;
  if (expect.text !== undefined) return `the screen shows "${expect.text}"`;
  if (expect.anyText !== undefined) return `the screen shows one of ${expect.anyText.map((text) => `"${text}"`).join(', ')}`;
  if (expect.absent !== undefined) return `"${expect.absent}" is no longer shown`;
  return `the app logs /${expect.logcat}/`;
}

module.exports = { validateExpect, checkExpect, describeExpect };
