/**
 * registry.js — create plugins by kind and name, and validate them against their contract.
 *
 * Factories are synchronous and receive the options object unchanged. Nothing here knows about a device,
 * a model or an app: built-ins are registered by builtins.js, user plugins by whoever builds the registry.
 */
const { KINDS, assertContract } = require('./contracts');

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
}

function createRegistry() {
  const factories = new Map(); // kind -> Map(name -> factory)
  for (const kind of KINDS) factories.set(kind, new Map());

  return {
    register(kind, name, factory) {
      checkKind(kind);
      if (typeof name !== 'string' || !name) throw new Error('plugin name must be a non-empty string');
      if (typeof factory !== 'function') throw new Error(`factory for ${kind}:${name} must be a function`);
      const byName = factories.get(kind);
      if (byName.has(name)) throw new Error(`${kind}:${name} is already registered`);
      byName.set(name, factory);
    },

    has(kind, name) {
      return KINDS.includes(kind) && factories.get(kind).has(name);
    },

    list(kind) {
      checkKind(kind);
      return [...factories.get(kind).keys()].sort();
    },

    create(kind, name, options) {
      checkKind(kind);
      const byName = factories.get(kind);
      const factory = byName.get(name);
      if (!factory) {
        const available = [...byName.keys()].sort().join(', ') || 'none';
        throw new Error(`no ${kind} plugin named "${name}" (available: ${available})`);
      }
      return assertContract(kind, factory(options));
    },
  };
}

module.exports = { createRegistry };