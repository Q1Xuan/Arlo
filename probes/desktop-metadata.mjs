import { closeSync, openSync, readSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) throw new Error('Supply the installed desktop executable path');
const resources = path.join(path.dirname(executable), 'resources');
const archive = path.join(resources, 'app.asar');
const handle = openSync(archive, 'r');
let manifest, runtime;
try {
  // Read ASAR metadata as data; never import application-private modules.
  const prefix = Buffer.alloc(16);
  readSync(handle, prefix, 0, 16, 0);
  const jsonLength = prefix.readUInt32LE(12);
  if (jsonLength > 32 * 1024 * 1024) throw new Error('Unexpected ASAR header size');
  const header = Buffer.alloc(jsonLength);
  readSync(handle, header, 0, jsonLength, 16);
  const tree = JSON.parse(header.toString('utf8'));
  function readJson(parts) {
    let entry = tree;
    for (const part of parts) entry = entry.files[part];
    if (!Number.isSafeInteger(entry.size) || entry.size > 32 * 1024 * 1024 || entry.unpacked) throw new Error('Unexpected metadata entry');
    const bytes = Buffer.alloc(entry.size);
    readSync(handle, bytes, 0, bytes.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    return JSON.parse(bytes.toString('utf8'));
  }
  manifest = readJson(['package.json']);
  runtime = readJson(['dsh', 'desktop-runtime.json']);
} finally {
  closeSync(handle);
}
const report = {
  target: 'installed-desktop', name: manifest.name, version: manifest.version,
  appAsarSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  release: runtime.release, platform: runtime.platform, arch: runtime.arch,
  sharedPackages: runtime.sharedPackages.map(({ name, version }) => ({ name, version })),
  primaryRuntime: JSON.parse(readFileSync(path.join(resources, 'runtime/primary-runtime/runtime.json'), 'utf8')),
  status: 'metadata-only; desktop renderer and installed Host package integration not yet verified',
};
writeFileSync(new URL('../docs/compatibility/desktop-installation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`Desktop ${report.version}; host Node ${runtime.release.nodeVersion}; ${runtime.sharedPackages.length} shared packages recorded.`);
