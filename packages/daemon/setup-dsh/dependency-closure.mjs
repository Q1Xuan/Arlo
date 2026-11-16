import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inspectDshInstallation, installedPackage } from './installed-host.mjs';

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
function canonicalLock(lock, hostOnly = false, boundRoots) {
  if (String(lock.lockfileVersion) !== '9' && String(lock.lockfileVersion) !== '9.0') throw new Error('Unsupported lock');
  if (!lock.packages || !lock.snapshots || Object.keys(lock.importers ?? {}).join(',') !== '.') throw new Error('Incomplete lock');
  const roots = Object.fromEntries(Object.entries(lock.importers['.'].dependencies ?? {})
    .filter(([name]) => boundRoots ? boundRoots.includes(name) : name.startsWith('@deepseek-ai/') || !hostOnly && name === '@arlo/adapter-dsh')
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
function inspectDependencyClosure(consumer, hostRequire, hostOnly, boundRoots) {
  consumer = fs.realpathSync(consumer);
  // js-yaml is the installed DSH's existing declared dependency. No workspace
  // parser or developer package is needed by a private installed diagnostic.
  const lock = hostRequire('js-yaml').load(fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8'));
  const canonical = canonicalLock(lock, hostOnly, boundRoots);
  const nodes = new Map();
  const directories = {};
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
    directories[directory] = `${name}@${version}`;
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
    manifestRouting: Object.fromEntries([...nodes].map(([id, record]) => [id, record.manifestSha256])),
    ...(boundRoots ? { installedDirectories: directories } : {}) };
}

/** Fixed roots for a host that exists before Arlo is consumed. */
export function inspectDshHostDependencyClosure(consumer, hostRequire) {
  return inspectDependencyClosure(consumer, hostRequire, true);
}
export function inspectDshDependencyClosure(consumer, hostRequire) {
  return inspectDependencyClosure(consumer, hostRequire, false);
}

const ordinaryRoots = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots'];
/** Native npm lock or scoped pnpm lock plus actual resolved required/optional
 * and peer modules. Unrelated owner roots are preserved, never runtime roots. */
export function inspectDshBoundHostDependencyClosure(selected) {
  const host = inspectDshInstallation(selected.selector ?? selected);
  const hostRequire = createRequire(path.join(host.directory, 'package.json'));
  if (host.manager === 'pnpm') return inspectDependencyClosure(host.owner, hostRequire, true, ordinaryRoots);
  const lock = JSON.parse(fs.readFileSync(path.join(host.owner, host.selector.lockFile), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(host.owner, 'package.json'), 'utf8'));
  const roots = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies }).filter(name => ordinaryRoots.includes(name));
  const nodes = new Map();
  const directories = {};
  const records = {};
  const optionalMissing = new Set();
  const visit = (require, name, optional = false) => {
    const identity = installedPackage(require, name, host.owner);
    if (!identity) {
      if (optional) { optionalMissing.add(name); return; }
      throw new Error(`Missing required dependency: ${name}`);
    }
    const key = path.relative(host.owner, identity.directory).replaceAll(path.sep, '/');
    const record = lock.packages[key];
    if (!record || record.link || record.version !== identity.version || typeof record.integrity !== 'string' || !/^https?:/.test(record.resolved ?? '')) throw new Error(`Unlocked installed dependency: ${name}`);
    const file = path.join(identity.directory, 'package.json');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = `${name}@${identity.version}`;
    directories[identity.directory] = id;
    records[key] = record;
    if (nodes.has(key)) return key;
    const dependencies = { ...installed.dependencies, ...installed.optionalDependencies, ...installed.peerDependencies };
    const locked = { ...record.dependencies, ...record.optionalDependencies, ...record.peerDependencies };
    for (const [dependency, range] of Object.entries(dependencies)) if (locked[dependency] !== range) throw new Error(`Changed dependency selector: ${dependency}`);
    const node = { manifestSha256: manifestSha256(Object.fromEntries(manifestFields.filter(field => field in installed).map(field => [field, installed[field]]))), dependencies: {} };
    nodes.set(key, node);
    const childRequire = createRequire(file);
    for (const dependency of Object.keys(dependencies)) {
      const missingAllowed = Object.hasOwn(installed.optionalDependencies ?? {}, dependency) || installed.peerDependenciesMeta?.[dependency]?.optional === true;
      node.dependencies[dependency] = visit(childRequire, dependency, missingAllowed) ?? 'optional-not-installed';
    }
    return key;
  };
  const require = createRequire(path.join(host.owner, 'package.json'));
  const rootReferences = Object.fromEntries(roots.map(name => [name, visit(require, name)]));
  const optional = [...optionalMissing].sort();
  return { lockSha256: digest({ manager: 'npm', lockfileVersion: lock.lockfileVersion, roots: rootReferences, packages: records }),
    installedIdentitySha256: digest({ nodes: Object.fromEntries(nodes), optionalMissing: optional }), installedPackages: nodes.size,
    optionalNotInstalled: optional, installedDirectories: directories,
    manifestRouting: Object.fromEntries(Object.entries(directories).map(([directory, id]) => [id, nodes.get(path.relative(host.owner, directory).replaceAll(path.sep, '/')).manifestSha256])) };
}

/** A companion's standard locked runtime graph plus the independently locked
 * selected Host graph. Native links are borrowed edges, never new DSH nodes. */
export function inspectDshBoundCompositionDependencyClosure(consumer, selected) {
  consumer = fs.realpathSync(consumer);
  const host = inspectDshInstallation(selected.selector ?? selected);
  const hostRequire = createRequire(path.join(host.directory, 'package.json'));
  const hostClosure = inspectDshBoundHostDependencyClosure(host);
  const manifest = JSON.parse(fs.readFileSync(path.join(consumer, 'package.json'), 'utf8'));
  const pnpm = fs.existsSync(path.join(consumer, 'pnpm-lock.yaml'));
  const lock = pnpm ? hostRequire('js-yaml').load(fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8'))
    : JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
  if (pnpm && Object.keys(lock.importers ?? {}).join(',') !== '.' || !pnpm && ![2, 3].includes(lock.lockfileVersion)) throw new Error('Invalid companion lock');
  const native = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'));
  const borrowed = Object.fromEntries(native.map(name => {
    const identity = name === '@deepseek-ai/dsh' ? { directory: host.directory, version: host.version }
      : installedPackage(hostRequire, name, host.owner);
    if (!identity) throw new Error(`Missing borrowed module: ${name}`);
    const declaration = `${pnpm ? 'link' : 'file'}:${identity.directory}`;
    if (manifest.dependencies[name] !== declaration) throw new Error(`Changed borrowed selector: ${name}`);
    return [name, identity];
  }));
  const nodes = new Map(), records = {}, manifests = {}, missing = new Set();
  const resolve = (require, name) => {
    for (const lookup of require.resolve.paths(name) ?? []) {
      const file = path.join(lookup, name, 'package.json');
      if (fs.existsSync(file)) return fs.realpathSync(path.dirname(file));
    }
    return null;
  };
  const visit = (require, name, reference, optional = false) => {
    const directory = resolve(require, name);
    if (!directory) { if (optional) { missing.add(name); return 'optional-not-installed'; } throw new Error(`Missing companion dependency: ${name}`); }
    if (name.startsWith('@deepseek-ai/')) {
      const expected = borrowed[name];
      if (!expected || directory !== expected.directory) throw new Error(`Substituted native module: ${name}`);
      if (pnpm && !reference?.startsWith('link:')) throw new Error(`Unrecorded native link: ${name}`);
      return `borrowed:${name}@${expected.version}`;
    }
    if (!directory.startsWith(path.join(consumer, 'node_modules') + path.sep)) throw new Error('Companion dependency outside its owner');
    const file = path.join(directory, 'package.json'), installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (installed.name !== name) throw new Error('Companion package identity mismatch');
    const id = `${name}@${installed.version}`;
    const key = pnpm ? `${name}@${reference}` : path.relative(consumer, directory).replaceAll(path.sep, '/');
    const record = pnpm ? lock.packages[key.split('(')[0]] : lock.packages[key];
    const snapshot = pnpm ? lock.snapshots[key] : record;
    if (!record || !snapshot || record.link || (record.version ?? reference.split('(')[0]) !== installed.version
      || typeof (pnpm ? record.resolution?.integrity : record.integrity) !== 'string') throw new Error('Unverified companion registry dependency');
    records[key] = record;
    const identity = `${key}\0${directory}`;
    if (nodes.has(identity)) return id;
    const node = { manifestSha256: manifestSha256(Object.fromEntries(manifestFields.filter(field => field in installed).map(field => [field, installed[field]]))), dependencies: {} };
    nodes.set(identity, node); manifests[id] = node.manifestSha256;
    const declarations = { ...installed.dependencies, ...installed.optionalDependencies, ...installed.peerDependencies };
    const locked = pnpm ? { ...snapshot.dependencies, ...snapshot.optionalDependencies }
      : { ...record.dependencies, ...record.optionalDependencies, ...record.peerDependencies };
    for (const [dependency, range] of Object.entries(declarations)) {
      const missingAllowed = Object.hasOwn(installed.optionalDependencies ?? {}, dependency) || installed.peerDependenciesMeta?.[dependency]?.optional === true;
      if (!Object.hasOwn(locked, dependency)) {
        if (missingAllowed && !resolve(createRequire(file), dependency)) continue;
        throw new Error(`Unrecorded companion dependency: ${dependency}`);
      }
      if (!pnpm && locked[dependency] !== range) throw new Error('Changed companion dependency selector');
      node.dependencies[dependency] = visit(createRequire(file), dependency, pnpm ? locked[dependency] : '', missingAllowed);
    }
    if (pnpm) for (const [dependency, target] of Object.entries(locked)) if (!Object.hasOwn(declarations, dependency)) {
      node.dependencies[dependency] = visit(createRequire(file), dependency, target, Object.hasOwn(snapshot.optionalDependencies ?? {}, dependency));
    }
    return id;
  };
  const require = createRequire(path.join(consumer, 'package.json'));
  const roots = Object.fromEntries(Object.keys(manifest.dependencies).filter(name => !name.startsWith('@deepseek-ai/')).map(name =>
    [name, visit(require, name, pnpm ? lock.importers['.'].dependencies[name]?.version : '')]));
  for (const name of native) visit(require, name, pnpm ? lock.importers['.'].dependencies[name]?.version : '');
  return { lockSha256: digest({ host: hostClosure.lockSha256, roots, records }),
    installedIdentitySha256: digest({ host: hostClosure.installedIdentitySha256, nodes: Object.fromEntries(nodes), missing: [...missing].sort() }),
    installedPackages: hostClosure.installedPackages + nodes.size, optionalNotInstalled: [...hostClosure.optionalNotInstalled, ...missing].sort(),
    manifestRouting: { ...hostClosure.manifestRouting, ...manifests } };
}
/** Maintainer metadata generation from reviewed locks, never a user-target expectation. */
export function dshHostLockSha256(lock) { return digest(canonicalLock(lock, true).value); }
