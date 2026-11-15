/** Exact host version supported by this adapter's patches and resource transform. */
export const dshVersion: '0.2.0-rc.2';
export const dshWebDependencies: Readonly<Record<string, string>>;
export function prepareDshWebConsumer(bundle: string): {
  patchedDependencies: Record<string, string>;
  files: string[];
};
export function verifyDshVersion(version: string): void;
export function dshCliPath(consumer: string): string;
export function patchWebPrimitives(consumer: string): {
  packageVersion: string;
  asset: string;
  originalSha256: string;
  patchedSha256: string;
};
export interface WindowsEnvironment {
  osRelease: string;
  productName: string;
  displayVersion: string;
  build: string;
}
export interface DshCompositionReport {
  schemaVersion: 1;
  mode: 'verified' | 'experimental';
  hostVersion: string | null;
  status: 'rejected' | 'experimental' | 'verified';
  ready: boolean;
  formallySupported: boolean;
  hostSupportPolicy: 'formal' | 'experimental-required';
  runtime: { platform: string; arch: string; node: string };
  observedWindows?: (WindowsEnvironment & { status: 'observed'; source: 'windows-registry' }) |
    { status: 'unavailable'; osRelease: string; reason: 'WINDOWS_METADATA_UNAVAILABLE' };
  requiredContracts: { ready: boolean; reason: string; scope: 'installed-composition' };
  installation: {
    compositionSha256: string; lockSha256: string | null;
    adapter: { name: string; version: string; artifactSha256: string } | null;
    binding: 'bound' | 'unavailable';
  };
  environmentEvidence: {
    status: 'verified' | 'failed' | 'unverified';
    reason: 'MATCHED' | 'NO_MATCH' | 'EVIDENCE_UNAVAILABLE' | 'INSTALLATION_IDENTITY_MISMATCH';
    acceptance?: 'passed' | 'passed-applicable' | 'failed'; scope?: string;
    testedCapabilities: string[]; limitations: string[]; evidence: string[];
    measuredWindows?: WindowsEnvironment[];
  };
  combination: string;
  lockSha256: string | null;
  dependencyClosure: {
    lockSha256: string; installedIdentitySha256: string;
    installedPackages: number; optionalNotInstalled: string[];
  } | null;
  packages: Record<string, string>;
  contracts: Record<string, string>;
  patches: Record<string, string>;
  frontend: { asset?: string; sha256?: string; files?: Record<string, string>; resourceSha256?: string } | null;
  checks: Array<{ code: string; subject: string; ok: boolean }>;
  reason: string;
  guidance: string;
}
export function inspectDshWebComposition(consumer: string, options?: { experimental?: boolean }): DshCompositionReport;
export function requireDshWebComposition(consumer: string, options?: { experimental?: boolean }): DshCompositionReport;
export function dshInstallationDirectory(entry: string): string;
export function requireDshHostContracts(ctx: unknown, options?: { experimental?: boolean; hostVersion?: string | null }): void;
