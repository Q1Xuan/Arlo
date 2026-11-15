import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSourceSha256 } from './source-fingerprint.mjs';
import { ARLO_PINNED_WIRE_REVISION } from './mcp-notification.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = path.join(root, 'node_modules/.pnpm');
// pnpm retains old store entries after removals. Only report artifacts present
// in this lockfile, never leftover packages from another candidate.
const lockfile = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
const locked = new Set([...lockfile.matchAll(/^ {2}(?:'([^']+)'|([^\s][^:]*)):\r?$/gm)]
  .map(match => match[1] ?? match[2]));
const packages = new Map();
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue;
  const modules = path.join(store, entry.name, 'node_modules');
  for (const scope of readdirSync(modules, { withFileTypes: true })) {
    if (scope.name === '.bin') continue;
    const location = path.join(modules, scope.name);
    const dirs = scope.name.startsWith('@')
      ? readdirSync(location).map(name => path.join(location, name)) : [location];
    for (const dir of dirs) {
      const manifest = JSON.parse(readFileSync(path.join(realpathSync(dir), 'package.json'), 'utf8'));
      if (!locked.has(`${manifest.name}@${manifest.version}`)) continue;
      packages.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name, version: manifest.version,
        license: manifest.license ?? null, engines: manifest.engines ?? null,
        exports: manifest.exports ?? null,
      });
    }
  }
}
const evidencePath = path.join(root, 'docs/compatibility/transport-run.json');
const transportEvidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
const lockSha256 = createHash('sha256').update(lockfile).digest('hex');
const installedTransportPath = path.join(root, 'docs/compatibility/desktop-transport-run.json');
const installedTransport = existsSync(installedTransportPath) ? JSON.parse(readFileSync(installedTransportPath, 'utf8')) : null;
const verified = transportEvidence?.overallStatus === 'PASS' && transportEvidence.lockSha256 === lockSha256 &&
  transportEvidence.sourceSha256 === probeSourceSha256(root) && transportEvidence.wireRevision === ARLO_PINNED_WIRE_REVISION &&
  installedTransport?.overallStatus === 'PASS' && installedTransport.sourceSha256 === transportEvidence.sourceSha256 &&
  transportEvidence.installedHost?.evidenceSha256 === createHash('sha256').update(readFileSync(installedTransportPath)).digest('hex');
const report = {
  candidateSource: {
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    commit: '639ed015397290b3745d163aafe02ffee4aa3f84',
    tag: 'dsh-v0.2.0-rc.2',
    engines: '^22.19.0 || >=24.0.0', license: 'MIT',
    note: 'Source reference, not an assertion of byte-identical npm provenance. Runtime artifacts are pinned by pnpm-lock.yaml integrity.',
  },
  node: process.version, pnpm: '10.26.2',
  lockSha256,
  mcp: {
    client: '2.0.0',
    server: '2.0.0',
    ...(verified ? { wireRevision: transportEvidence.wireRevision } : { wireCandidate: ARLO_PINNED_WIRE_REVISION }),
    profile: 'arlo/session-messaging',
    profileVersion: '0.1',
    status: verified ? 'verified' : 'not-verified-for-current-source',
    evidenceFile: 'docs/compatibility/transport-run.json',
  },
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
writeFileSync(path.join(root, 'docs/compatibility/versions.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Recorded ${packages.size} exact installed package manifests; no compatibility pass implied.`);
