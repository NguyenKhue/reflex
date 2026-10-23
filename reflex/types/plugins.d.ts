/**
 * plugins.d.ts — the plugin contracts of reflex (contract version 0.1.0) as TypeScript types.
 *
 * reflex itself stays JavaScript (docs/reflex/DESIGN.md D10): these declarations are for people who write a plugin, so their editor and
 * `tsc` can check it against the same contract `src/core/contracts.js` enforces at run time. Keep the two in step.
 */
export declare const CONTRACT_VERSION: string;

export type PluginKind = 'device' | 'decider' | 'account' | 'otp' | 'reporter' | 'extractor';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotNode {
  ref: string | null;
  pinned: string | null;
  type: string;
  role: string;
  label: string;
  value: string;
  text: string;
  identifier: string | null;
  rect: Rect | null;
  enabled: boolean;
  hittable: boolean;
  editable: boolean;
  focused: boolean;
  password: boolean;
  hintShowing: boolean;
}

export interface Snapshot {
  generation?: number;
  truncated: boolean;
  sparse: boolean;
  appBundleId: string | null;
  takenAt: number;
  /** 'uiautomator' when the screen was read through adb because agent-device could not see it (system windows). */
  source?: 'uiautomator';
  nodes: SnapshotNode[];
}

export type ActionTarget = SnapshotNode | string | { selector: string } | { x: number; y: number };

export interface Plugin {
  /** The contract version this plugin was written for; a different MAJOR than reflex's is refused when the plugin is created. */
  contractVersion?: string;
}

export interface DeviceBackend extends Plugin {
  open(options?: { app?: string; activity?: string; relaunch?: boolean; extras?: Record<string, unknown> }): Promise<unknown>;
  resetApp(options?: { app?: string; grants?: string[] }): Promise<unknown>;
  snapshot(): Promise<Snapshot>;
  press(target: ActionTarget, options?: { settle?: boolean }): Promise<unknown>;
  fill(target: ActionTarget, text: string, options?: { charDelayMs?: number }): Promise<unknown>;
  scroll(direction?: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<unknown>;
  back(): Promise<unknown>;
  keyboard?(action: 'enter' | 'dismiss'): Promise<unknown>;
  screenshot(filePath: string): Promise<unknown>;
  close(): Promise<unknown>;
  meta(): Record<string, unknown>;
  swipe?(from: unknown, to: unknown): Promise<unknown>;
  clearLogcat?(): Promise<unknown>;
  readLogcat?(): Promise<string>;
}

export interface DecisionRequest {
  state: Record<string, unknown>;
  instruction: string;
  /** `{ <actionId>: <description> }`: the closed set the decider must choose from. */
  options: Record<string, string>;
}

export interface Decision {
  choice?: string;
  confidence?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  latency_ms?: number;
  model?: string;
}

export interface Decider extends Plugin {
  decide(request: DecisionRequest): Promise<Decision>;
}

export interface AccountProvider extends Plugin {
  get(name: string, context?: { platform?: string; plan?: unknown; row?: unknown }): string | undefined | null;
}

export interface OtpProvider extends Plugin {
  getOtp(phone: string): Promise<string>;
}

export interface Reporter extends Plugin {
  report(summary: unknown, context?: { reportDir?: string }): Promise<unknown>;
}

export interface ContextExtractor extends Plugin {
  extract(request: { rootDir: string }): Promise<Record<string, unknown>>;
}

export interface PluginMap {
  device: DeviceBackend;
  decider: Decider;
  account: AccountProvider;
  otp: OtpProvider;
  reporter: Reporter;
  extractor: ContextExtractor;
}

export interface Registry {
  register<K extends PluginKind>(kind: K, name: string, factory: (options?: any) => PluginMap[K]): void;
  has(kind: PluginKind, name: string): boolean;
  list(kind: PluginKind): string[];
  create<K extends PluginKind>(kind: K, name: string, options?: unknown): PluginMap[K];
}
