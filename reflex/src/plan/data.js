/**
 * data.js — resolve one data row of a plan into the values its steps interpolate.
 *
 * Fallback chain per input: row column → `{env:VAR}` (shell env or `<workspace>/.env`, both
 * land in process.env) → the account provider: REFLEX_TEST_PHONE/PASSWORD/PIN (`_ANDROID`/`_IOS` first),
 * then workspace `defaults.account` → the input's `default`. Values never
 * appear in an error: they can be phones, passwords, PINs.
 */
const { isSixDigitPin } = require('../util/credentials');
const { createEnvAccountProvider } = require('../core/accounts/env');

const ENV_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ACCOUNT_INPUTS = ['phone', 'password', 'pin'];
const ALWAYS_SECRET = ['password', 'pin', 'otp'];

function resolveEnvRefs(value, column) {
  return value.replace(ENV_REF, (_, name) => {
    if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
    throw new Error(`input "${column}" needs env ${name} — set it in workspace/.env or export it`);
  });
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function resolveRowData(plan, row, { workspace, platform, accounts = null }) {
  const data = { ...(row || {}) };
  delete data.id; // the row id names the case, it is not plan data
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.includes('{env:')) data[key] = resolveEnvRefs(value, key);
  }

  const inputNames = new Set(plan.inputs.map((input) => input.name));
  const provider = accounts || createEnvAccountProvider({ workspace });
  for (const name of ACCOUNT_INPUTS) {
    if (!inputNames.has(name) || !isEmpty(data[name])) continue;
    const value = provider.get(name, { platform });
    if (!isEmpty(value)) data[name] = String(value);
  }
  // A 6-digit login password doubles as the wallet PIN.
  if (inputNames.has('pin') && isEmpty(data.pin) && isSixDigitPin(data.password)) data.pin = String(data.password).trim();

  for (const input of plan.inputs) {
    if (isEmpty(data[input.name]) && input.default !== undefined) data[input.name] = input.default;
    if (input.required && isEmpty(data[input.name])) throw new Error(`plan "${plan.name}" requires input "${input.name}"`);
  }
  return data;
}

/** Names whose values must never reach Jev, a trace or a report. */
function secretKeys(plan) {
  return new Set([...plan.inputs.filter((input) => input.secret).map((input) => input.name), ...ALWAYS_SECRET]);
}

module.exports = { resolveRowData, secretKeys };
