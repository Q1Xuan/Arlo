import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalSha256, manifestSha256 } from './dependency-closure.mjs';
import { observeWindows, validWindowsEnvironment } from './windows.mjs';

/** A reproducible host profile; private lock/tarball paths remain separate installation evidence. */
function hostProfileSha256({ hostVersion, packages, contracts, patches, frontend, dependencyClosure, runtimeManifestProfileSha256 }) {
  return canonicalSha256({ hostVersion, packages, patches, frontend, runtimeManifestProfileSha256,
    dependencyClosure: dependencyClosure?.lockSha256 ?? null,
    contracts: Object.fromEntries(Object.entries(contracts).filter(([key]) => !key.startsWith('@arlo/'))),
  });
}

/** Actual executable/declaration/configuration bytes, excluding the evidence JSON to avoid recursion. */
export function dshAdapterArtifactSha256(directory) {
  const hash = createHash('sha256');
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })
      .filter(entry => entry.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && file !== 'delivery/environment-evidence.json' && /\.(?:[cm]?js|[cm]?ts|ya?ml|json)$/.test(entry.name)) {
        const bytes = fs.readFileSync(path.join(directory, file));
        // pnpm repacks package.json with different whitespace. Bind every
        // manifest value while retaining raw hashes for executable/reference files.
        hash.update(file).update('\0').update(file === 'package.json'
          ? manifestSha256(JSON.parse(bytes.toString('utf8'))) : bytes).update('\0');
      } else if (entry.isSymbolicLink()) throw new Error('Adapter artifact contains a symbolic link');
    }
  };
  visit('');
  return hash.digest('hex');
}

/** The Web builder binds metadata after candidate adaptation and before packing. */
export function bindDshEnvironmentEvidence(directory) {
  const file = path.join(directory, 'delivery/environment-evidence.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  data.adapter = { name: manifest.name, version: manifest.version, artifactSha256: dshAdapterArtifactSha256(directory) };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Read the inspected consumer's own evidence; never substitute workspace metadata. */
export function inspectDshEnvironment(directory, composition) {
  const runtime = { platform: process.platform, arch: process.arch, node: process.versions.node };
  const observedWindows = process.platform === 'win32' ? observeWindows() : undefined;
  let measuredWindows;
  const installation = { compositionSha256: hostProfileSha256(composition),
    lockSha256: composition.lockSha256, adapter: null, binding: 'unavailable' };
  const unverified = reason => ({ runtime, observedWindows, installation, environmentEvidence: {
    status: 'unverified', reason, testedCapabilities: [], limitations: ['当前环境尚未验证'], evidence: [],
    ...(measuredWindows ? { measuredWindows } : {}),
  } });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    installation.adapter = { name: manifest.name, version: manifest.version, artifactSha256: dshAdapterArtifactSha256(directory) };
  } catch { return unverified('INSTALLATION_IDENTITY_MISMATCH'); }
  if (!composition.runtimeIdentityVerified) return unverified('INSTALLATION_IDENTITY_MISMATCH');
  try {
    const data = JSON.parse(fs.readFileSync(path.join(directory, 'delivery/environment-evidence.json'), 'utf8'));
    if (data.schemaVersion !== 1 || data.host !== 'dsh' || !Array.isArray(data.rows)) throw new Error('Evidence unavailable');
    if (data.adapter?.name !== installation.adapter.name || data.adapter?.version !== installation.adapter.version ||
        data.adapter?.artifactSha256 !== installation.adapter.artifactSha256) return unverified('INSTALLATION_IDENTITY_MISMATCH');
    installation.binding = 'bound';
    const rows = data.rows.filter(row => row.version === composition.hostVersion &&
      row.platform === runtime.platform && row.arch === runtime.arch && row.node === runtime.node);
    if (!rows.length) return unverified('NO_MATCH');
    const identityRows = rows.filter(row => row.compositionSha256 === installation.compositionSha256);
    if (!identityRows.length) return unverified('INSTALLATION_IDENTITY_MISMATCH');
    if (observedWindows) measuredWindows = identityRows.filter(row => validWindowsEnvironment(row.windows))
      .map(row => ({ osRelease: row.windows.osRelease, productName: row.windows.productName,
        displayVersion: row.windows.displayVersion, build: row.windows.build }));
    const row = identityRows.find(row => !observedWindows || (observedWindows.status === 'observed' &&
      validWindowsEnvironment(row.windows) && row.windows.osRelease === observedWindows.osRelease &&
      row.windows.productName === observedWindows.productName && row.windows.displayVersion === observedWindows.displayVersion &&
      row.windows.build === observedWindows.build));
    if (!row) return unverified('NO_MATCH');
    if (!['passed', 'passed-applicable', 'failed'].includes(row.acceptance) ||
        [row.testedCapabilities, row.limitations, row.evidence].some(values =>
          !Array.isArray(values) || values.some(value => typeof value !== 'string')) || !row.evidence.length) {
      throw new Error('Evidence unavailable');
    }
    return { runtime, observedWindows, installation, environmentEvidence: {
      status: row.acceptance === 'failed' ? 'failed' : 'verified', reason: 'MATCHED', acceptance: row.acceptance,
      testedCapabilities: row.testedCapabilities, limitations: row.limitations, evidence: row.evidence, scope: data.scope,
      ...(measuredWindows ? { measuredWindows } : {}),
    } };
  } catch { return unverified('EVIDENCE_UNAVAILABLE'); }
}
