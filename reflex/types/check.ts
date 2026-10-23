import type { AccountProvider, ContextExtractor, Decider, DeviceBackend, OtpProvider, Registry, Reporter, Snapshot } from './plugins';

const snapshot: Snapshot = { truncated: false, sparse: false, appBundleId: null, takenAt: 0, nodes: [] };

const device: DeviceBackend = {
  contractVersion: '0.1.0',
  async open() { return { ok: true }; },
  async resetApp() { return { ok: true }; },
  async snapshot() { return snapshot; },
  async press() { return { ok: true }; },
  async fill() { return { ok: true }; },
  async scroll() { return { ok: true }; },
  async back() { return { ok: true }; },
  async screenshot() { return { ok: true }; },
  async close() { return undefined; },
  meta() { return { platform: 'android' }; },
};

const decider: Decider = {
  async decide({ options }) {
    return { choice: Object.keys(options)[0], confidence: 0.9 };
  },
};

const account: AccountProvider = { get: (name) => (name === 'phone' ? '0900000001' : undefined) };
const otp: OtpProvider = { getOtp: async () => '123456' };
const reporter: Reporter = { report: async () => undefined };
const extractor: ContextExtractor = { extract: async () => ({}) };

declare const registry: Registry;
registry.register('device', 'mine', () => device);
registry.register('decider', 'mine', () => decider);
registry.register('account', 'mine', () => account);
registry.register('otp', 'mine', () => otp);
registry.register('reporter', 'mine', () => reporter);
registry.register('extractor', 'mine', () => extractor);

const made = registry.create('device', 'mine');
made.snapshot().then((shot: Snapshot) => shot.nodes.length);

// @ts-expect-error a decider must have `decide`
const noDecide: Decider = {};
// @ts-expect-error a device factory must not return a decider
registry.register('device', 'wrong', () => decider);
// @ts-expect-error unknown plugin kind
registry.list('sensor');
// @ts-expect-error a snapshot needs its nodes
const noNodes: Snapshot = { truncated: false, sparse: false, appBundleId: null, takenAt: 0 };

export { noDecide, noNodes };
