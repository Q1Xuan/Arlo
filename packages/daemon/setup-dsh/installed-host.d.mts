export interface DshInstallationSelector {
  owner: string; packageDirectory: string; packageName: '@deepseek-ai/dsh'; importer: '.';
  manager: 'npm' | 'pnpm'; lockFile: string;
}
export interface DshInstalledHost {
  family: 'dsh'; selector: DshInstallationSelector; directory: string; version: string; bin: string; owner: string;
  manager: 'npm' | 'pnpm'; managerVersion?: string; storeDirectory?: string;
  peers: Record<string, { directory: string; version: string; manifestSha256: string }>;
  evidence: Record<string, string>;
}
export function inspectDshInstallation(selected: string | DshInstallationSelector): DshInstalledHost;
export function dshBorrowedModules(host: DshInstalledHost, names: string[], allowMissing?: boolean): DshInstalledHost;
export function dshNativeLockParser(host: DshInstalledHost): { parse: (source: string) => any; stringify: (value: any) => string } | undefined;
export function installedPackage(require: NodeJS.Require, name: string, owner: string): { directory: string; version: string; manifestSha256: string } | null;
