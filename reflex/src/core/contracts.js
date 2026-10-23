/**
 * contracts.js — the plugin contracts of reflex (v0).
 *
 * A contract is only the set of methods the core calls. It is checked when a plugin is created (registry) so a
 * half-written plugin fails with a clear message at startup instead of halfway through a device run.
 * v0 on purpose: freeze these only after a second real app has used them (docs/reflex/DESIGN.md, D7).
 * A plugin may declare `contractVersion`; a different MAJOR than CONTRACT_VERSION is refused at create time.
 */
const CONTRACT_VERSION = '0.1.0'; // the version of the plugin contracts, not of the package: bump the MAJOR when a contract breaks
const majorOf = (version) => String(version).split('.')[0];

const CONTRACTS = {
  device: {
    required: ['open', 'resetApp', 'snapshot', 'press', 'fill', 'scroll', 'back', 'screenshot', 'close', 'meta'],
    optional: ['swipe', 'clearLogcat', 'readLogcat', 'keyboard'],
  },
  decider: { required: ['decide'], optional: [] },
  account: { required: ['get'], optional: [] },
  otp: { required: ['getOtp'], optional: [] },
  reporter: { required: ['report'], optional: [] },
  extractor: { required: ['extract'], optional: [] },
};

const KINDS = Object.freeze(Object.keys(CONTRACTS));

function assertContract(kind, instance) {
  const contract = CONTRACTS[kind];
  if (!contract) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
  if (instance === null || typeof instance !== 'object') {
    throw new Error(`${kind} plugin must be an object, got ${instance === null ? 'null' : typeof instance}`);
  }
  if (instance.contractVersion !== undefined && majorOf(instance.contractVersion) !== majorOf(CONTRACT_VERSION)) {
    throw new Error(`${kind} plugin targets contract ${instance.contractVersion} but this reflex provides ${CONTRACT_VERSION}`);
  }
  const missing = contract.required.filter((name) => typeof instance[name] !== 'function');
  if (missing.length) throw new Error(`${kind} plugin is missing: ${missing.join(', ')}`);
  return instance;
}

/** A copy, so a caller cannot change the contract by mutating what it got back. */
function describeContract(kind) {
  const contract = CONTRACTS[kind];
  if (!contract) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
  return { required: contract.required.slice(), optional: contract.optional.slice() };
}

module.exports = { CONTRACTS, CONTRACT_VERSION, KINDS, assertContract, describeContract };
