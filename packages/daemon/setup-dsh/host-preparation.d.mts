export interface DshHostPreparationReport {
  ready: boolean;
  hostVersion: string | null;
  hostSupportPolicy: 'formal' | 'experimental-required';
  requiredContracts: { ready: boolean; reason: string; scope: 'host-preparation' };
  dependencyClosure: { lockSha256: string; installedIdentitySha256: string; installedPackages: number; optionalNotInstalled: string[] } | null;
  reason: string;
  guidance: string;
  [key: string]: unknown;
}
export function inspectDshHostPreparation(consumer: string, options?: { experimental?: boolean }): DshHostPreparationReport;
