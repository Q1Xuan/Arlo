import fs from 'node:fs';
import path from 'node:path';
import { piAdapterArtifactSha256 } from './artifact.ts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { observeWindows, validWindowsEnvironment, type WindowsEnvironment } from './windows.ts';

const packageNames = ['pi-coding-agent', 'pi-tui', 'pi-ai', 'pi-agent-core', 'pi-codemode', 'pi-mcp', 'pi-telemetry']
  .map(name => `@earendil-works/${name}`);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

export interface PiEnvironmentRecord {
  version: string;
  platform: string;
  arch: string;
  node: string;
  windows?: WindowsEnvironment;
  packages: Record<string, string>;
  acceptance: 'passed' | 'passed-applicable' | 'failed';
  testedCapabilities: string[];
  limitations: string[];
  evidence: string[];
}

export interface PiEnvironmentEvidence {
  status: 'verified' | 'failed' | 'unverified';
  reason: 'MATCHED' | 'NO_MATCH' | 'EVIDENCE_UNAVAILABLE' | 'INSTALLATION_IDENTITY_MISMATCH';
  acceptance?: PiEnvironmentRecord['acceptance'];
  scope?: string;
  measuredWindows?: WindowsEnvironment[];
  testedCapabilities: string[];
  limitations: string[];
  evidence: string[];
}

export interface PiInstallationIdentity {
  adapter: { name: string; version: string; artifactSha256: string } | null;
  packages: Record<string, string>;
  binding: 'source' | 'bound' | 'unavailable';
}

export { piAdapterArtifactSha256 } from './artifact.ts';

function installedPackage(name: string): { name: string; version: string } {
  const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const resolver = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'].includes(name) ? require : hostRequire;
  for (const directory of resolver.resolve.paths(name) ?? []) {
    // The family can publish import-only exports; read its physical manifest
    // from the host's resolution path rather than requesting a require export.
    const manifest = path.join(directory, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const value = JSON.parse(fs.readFileSync(fs.realpathSync(manifest), 'utf8'));
    if (value.name !== name || typeof value.version !== 'string') throw new Error('Installed package identity unavailable');
    return { name, version: value.version };
  }
  throw new Error('Installed package identity unavailable');
}

export function inspectPiEnvironment(version: string) {
  const runtime = { platform: process.platform, arch: process.arch, node: process.versions.node };
  const observedWindows = process.platform === 'win32' ? observeWindows() : undefined;
  let measuredWindows: WindowsEnvironment[] | undefined;
  const installation: PiInstallationIdentity = {
    adapter: null,
    packages: {},
    binding: 'unavailable',
  };
  const unverified = (reason: PiEnvironmentEvidence['reason']): PiEnvironmentEvidence => ({
    status: 'unverified', reason, testedCapabilities: [], limitations: ['当前环境尚未验证'], evidence: [],
    ...(measuredWindows ? { measuredWindows } : {}),
  });
  try {
    const adapter = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    installation.adapter = { name: String(adapter.name), version: String(adapter.version),
      artifactSha256: piAdapterArtifactSha256(packageRoot) };
    for (const name of packageNames) installation.packages[name] = installedPackage(name).version;
    if (import.meta.url.endsWith('.ts')) installation.binding = 'source';
  } catch { return { runtime, observedWindows, installation, environmentEvidence: unverified('INSTALLATION_IDENTITY_MISMATCH') }; }
  try {
    const data = JSON.parse(fs.readFileSync(new URL('./environment-evidence.json', import.meta.url), 'utf8'));
    if (data.schemaVersion !== 1 || data.host !== 'pi' || typeof data.scope !== 'string' || !Array.isArray(data.rows)) throw new Error('Evidence unavailable');
    if (data.adapter?.name !== installation.adapter.name || data.adapter?.version !== installation.adapter.version ||
        (!import.meta.url.endsWith('.ts') && data.adapter.artifactSha256 !== installation.adapter.artifactSha256)) {
      return { runtime, observedWindows, installation, environmentEvidence: unverified('INSTALLATION_IDENTITY_MISMATCH') };
    }
    if (!import.meta.url.endsWith('.ts')) installation.binding = 'bound';
    const rows: PiEnvironmentRecord[] = data.rows.filter((item: PiEnvironmentRecord) => item.version === version &&
      item.platform === runtime.platform && item.arch === runtime.arch && item.node === runtime.node);
    if (observedWindows) measuredWindows = rows.filter(item => validWindowsEnvironment(item.windows))
      .map(item => ({ osRelease: item.windows!.osRelease, productName: item.windows!.productName,
        displayVersion: item.windows!.displayVersion, build: item.windows!.build }));
    const row = rows.find(item => !observedWindows || (observedWindows.status === 'observed' &&
      validWindowsEnvironment(item.windows) && item.windows.osRelease === observedWindows.osRelease &&
      item.windows.productName === observedWindows.productName && item.windows.displayVersion === observedWindows.displayVersion &&
      item.windows.build === observedWindows.build));
    if (!row) return { runtime, observedWindows, installation, environmentEvidence: unverified('NO_MATCH') };
    if (!row.packages || packageNames.some(name => row.packages[name] !== installation.packages[name])) {
      return { runtime, observedWindows, installation, environmentEvidence: unverified('INSTALLATION_IDENTITY_MISMATCH') };
    }
    if (!['passed', 'passed-applicable', 'failed'].includes(row.acceptance) ||
        [row.testedCapabilities, row.limitations, row.evidence].some(values =>
          !Array.isArray(values) || values.some(value => typeof value !== 'string')) || !row.evidence.length) {
      throw new Error('Evidence unavailable');
    }
    const environmentEvidence: PiEnvironmentEvidence = {
      status: row.acceptance === 'failed' ? 'failed' : 'verified', reason: 'MATCHED', acceptance: row.acceptance,
      testedCapabilities: row.testedCapabilities, limitations: row.limitations, evidence: row.evidence,
      scope: data.scope,
      ...(measuredWindows ? { measuredWindows } : {}),
    };
    return { runtime, observedWindows, installation, environmentEvidence };
  } catch { return { runtime, observedWindows, installation, environmentEvidence: unverified('EVIDENCE_UNAVAILABLE') }; }
}
