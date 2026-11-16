export function canonicalSha256(value: unknown): string;
export function manifestSha256(value: unknown): string;
export function inspectDshDependencyClosure(consumer: string, hostRequire: unknown): {
  lockSha256: string; installedIdentitySha256: string; installedPackages: number;
  optionalNotInstalled: string[]; manifestRouting: Record<string, string>;
};
export function inspectDshHostDependencyClosure(consumer: string, hostRequire: unknown): ReturnType<typeof inspectDshDependencyClosure>;
export function dshHostLockSha256(lock: unknown): string;
export function inspectDshBoundHostDependencyClosure(selected: import('./installed-host.mjs').DshInstalledHost | import('./installed-host.mjs').DshInstallationSelector):
  ReturnType<typeof inspectDshDependencyClosure> & { installedDirectories: Record<string, string> };
export function inspectDshBoundCompositionDependencyClosure(consumer: string, selected: import('./installed-host.mjs').DshInstalledHost | import('./installed-host.mjs').DshInstallationSelector): ReturnType<typeof inspectDshDependencyClosure>;
