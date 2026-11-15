import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, ordered(value[key])])) : value;
export const canonicalSha256 = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
// Conditional exports/imports are evaluated in declaration order. Manifest
// whitespace is irrelevant, but recursively sorting its objects changes routing.
export const manifestSha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = canonicalSha256;
const manifestFields = ['name', 'version', 'type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh',
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];

/** Complete Host/adapter closure; consumer acceptance tools are not runtime roots. */
function canonicalLock(lock, hostOnly = false) {
  if (String(lock.lockfileVersion) !== '9' && String(lock.lockfileVersion) !== '9.0') throw new Error('Unsupported lock');
  if (!lock.packages || !lock.snapshots || Object.keys(lock.importers ?? {}).join(',') !== '.') throw new Error('Incomplete lock');
  const roots = Object.fromEntries(Object.entries(lock.importers['.'].dependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/') || !hostOnly && name === '@arlo/adapter-dsh')
    .map(([name, record]) => [name, record.version]));
  if (!roots['@deepseek-ai/dsh'] || !hostOnly && !roots['@arlo/adapter-dsh']) throw new Error('Missing runtime roots');
  const packages = {};
  const snapshots = {};
  const collect = (name, reference) => {
    const id = `${name}@${reference}`;
    if (Object.hasOwn(snapshots, id)) return;
    const packageId = id.split('(')[0];
    if (!lock.snapshots[id] || !lock.packages[packageId]) throw new Error(`Missing runtime snapshot: ${name}`);
    snapshots[id] = lock.snapshots[id];
    packages[packageId] = lock.packages[packageId];
    for (const [dependency, target] of Object.entries({ ...snapshots[id].dependencies, ...snapshots[id].optionalDependencies })) {
      collect(dependency, target);
    }
  };
  for (const [name, reference] of Object.entries(roots)) collect(name, reference);
  const privateReferences = Object.entries(packages).flatMap(([id, record]) => {
    const match = id.match(/^(@arlo\/[^@]+)@(file:.+)$/);
    return match ? [[id, `${match[1]}@${record.version}`], [match[2], record.version]] : [];
  }).sort(([a], [b]) => b.length - a.length);
  const normalizeString = value => privateReferences.reduce((result, [from, to]) => result.replaceAll(from, to), value);
  const normalize = (value, key = '') => {
    if (Array.isArray(value)) return value.map(item => normalize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [normalizeString(field),
        key.startsWith('@arlo/') && field === 'resolution' ? { privateArtifact: true } : normalize(item, field)]));
    }
    return typeof value === 'string' ? normalizeString(value) : value;
  };
  // Patch paths are install locations; their hash and the actual patch bytes
  // remain checked. All public resolutions, metadata and peer snapshots remain.
  const normalized = normalize({ lockfileVersion: lock.lockfileVersion, settings: lock.settings, roots, packages, snapshots,
    patchedDependencies: Object.fromEntries(Object.entries(lock.patchedDependencies ?? {}).filter(([id]) => Object.hasOwn(packages, id))) });
  for (const record of Object.values(normalized.patchedDependencies ?? {})) delete record.path;
  for (const [id, record] of Object.entries(normalized.packages)) {
    if (!id.startsWith('@arlo/') && typeof record.resolution?.integrity !== 'string') throw new Error('Missing public integrity');
  }
  return { value: normalized, normalizeString, roots };
}

// Resolve manifests using Node's real dependency search, including packages
// whose exports intentionally hide package.json or have no executable entry.
function packageDirectory(require, name, consumer) {
  for (const lookup of require.resolve.paths(name) ?? []) {
    const manifest = path.join(lookup, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const directory = fs.realpathSync(path.dirname(manifest));
    if (!directory.startsWith(`${path.join(consumer, 'node_modules')}${path.sep}`)) throw new Error('Dependency outside installation');
    return directory;
  }
  return null;
}

/** Verify actual required modules/peer edges against every reachable snapshot. */
function inspectDependencyClosure(consumer, hostRequire, hostOnly) {
  consumer = fs.realpathSync(consumer);
  // js-yaml is the installed DSH's existing declared dependency. No workspace
  // parser or developer package is needed by a private installed diagnostic.
  const lock = hostRequire('js-yaml').load(fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8'));
  const canonical = canonicalLock(lock, hostOnly);
  const nodes = new Map();
  const visited = new Set();
  const optionalMissing = new Set();
  const visit = (require, name, reference, optional = false) => {
    const id = `${name}@${reference}`;
    const snapshot = lock.snapshots[id];
    const record = lock.packages[id.split('(')[0]];
    if (!snapshot || !record) throw new Error(`Missing snapshot: ${name}`);
    const directory = packageDirectory(require, name, consumer);
    if (!directory) {
      if (optional) { optionalMissing.add(canonical.normalizeString(id)); return; }
      throw new Error(`Missing required dependency: ${name}`);
    }
    const manifestFile = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const version = record.version ?? reference.split('(')[0];
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Changed dependency: ${name}`);
    const identity = `${directory}\0${id}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    const dependencies = { ...snapshot.dependencies, ...snapshot.optionalDependencies };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!Object.hasOwn(dependencies, dependency)) throw new Error(`Unlocked dependency: ${dependency}`);
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[peer]?.optional && !Object.hasOwn(dependencies, peer)) {
        throw new Error(`Missing required peer: ${peer}`);
      }
    }
    const normalizedId = canonical.normalizeString(id);
    const node = { manifestSha256: manifestSha256(Object.fromEntries(manifestFields.filter(field => field in manifest)
      .map(field => [field, manifest[field]]))), dependencies: Object.fromEntries(Object.entries(dependencies)
      .map(([dependency, target]) => [dependency, canonical.normalizeString(`${dependency}@${target}`)])) };
    if (nodes.has(normalizedId) && digest(nodes.get(normalizedId)) !== digest(node)) throw new Error('Divergent installed module identity');
    nodes.set(normalizedId, node);
    const childRequire = createRequire(manifestFile);
    for (const [dependency, target] of Object.entries(dependencies)) {
      visit(childRequire, dependency, target, Object.hasOwn(snapshot.optionalDependencies ?? {}, dependency));
    }
  };
  const require = createRequire(path.join(consumer, 'package.json'));
  for (const [name, reference] of Object.entries(canonical.roots)) visit(require, name, reference);
  const optional = [...optionalMissing].sort();
  return { lockSha256: digest(canonical.value), installedIdentitySha256: digest({ nodes: Object.fromEntries(nodes), optionalMissing: optional }),
    installedPackages: nodes.size, optionalNotInstalled: optional,
    manifestRouting: Object.fromEntries([...nodes].map(([id, record]) => [id, record.manifestSha256])) };
}

/** Fixed roots for a host that exists before Arlo is consumed. */
export function inspectDshHostDependencyClosure(consumer, hostRequire) {
  return inspectDependencyClosure(consumer, hostRequire, true);
}
export function inspectDshDependencyClosure(consumer, hostRequire) {
  return inspectDependencyClosure(consumer, hostRequire, false);
}
/** Maintainer metadata generation from reviewed locks, never a user-target expectation. */
export function dshHostLockSha256(lock) { return digest(canonicalLock(lock, true).value); }
