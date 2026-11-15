import assert from 'node:assert/strict';

// These helpers deliberately support the pinned pnpm v9 format and the generic
// packages' peer-free graph. A new lock shape must be reviewed, not guessed.
function section(lock, name) {
  const text = lock.replaceAll('\r\n', '\n');
  assert.match(text, /^lockfileVersion: '9\.0'$/m, 'Expected pnpm v9 lockfile');
  const heading = new RegExp(`^${name}:[ \\t]*$`, 'm').exec(text);
  assert.ok(heading, `Missing lockfile section: ${name}`);
  const rest = text.slice(heading.index + heading[0].length);
  const next = rest.search(/^\S/m);
  return { prefix: text.slice(0, heading.index), body: next < 0 ? rest : rest.slice(0, next) };
}

function entries(body) {
  const result = new Map();
  let current;
  let explicitValue = false;
  for (const line of body.split('\n')) {
    if (explicitValue) {
      assert.match(line, /^  :(?: .*)?$/, 'Expected explicit YAML key value');
      explicitValue = false;
      result.get(current).push(line);
      continue;
    }
    if (/^  \S/.test(line)) {
      const explicit = /^  \? '([^']+)'$/.exec(line);
      const match = explicit ?? /^  (?:'([^']+)'|([^:'"\s][^:\s]*)):(?: \{\})?$/.exec(line);
      assert.ok(match, `Unsupported lockfile entry: ${line}`);
      current = match[1] ?? match[2];
      assert.ok(!result.has(current), `Duplicate lockfile entry: ${current}`);
      result.set(current, []);
      explicitValue = explicit !== null;
    }
    if (current !== undefined) result.get(current).push(line);
    else assert.equal(line.trim(), '', 'Unexpected lockfile content before entries');
  }
  assert.equal(explicitValue, false, 'Missing explicit YAML key value');
  return new Map([...result].map(([key, lines]) => [key, lines.join('\n').trimEnd()]));
}

function exactVersion(value) {
  assert.match(value, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, `Expected exact peer-free registry version: ${value}`);
  return value;
}

function splitRegistryId(id) {
  const at = id.lastIndexOf('@');
  assert.ok(at > 0, `Invalid registry package: ${id}`);
  return [id.slice(0, at), exactVersion(id.slice(at + 1))];
}

function snapshotDependencies(block) {
  const dependencies = [];
  let inDependencies = false;
  for (const line of block.split('\n').slice(1)) {
    if (!line.trim()) continue;
    if (/^    (?:dependencies|optionalDependencies):$/.test(line)) {
      inDependencies = true;
      continue;
    }
    const dependency = /^      (?:'([^']+)'|([^:'"\s][^:\s]*)): '?([^'\s]+)'?$/.exec(line);
    assert.ok(inDependencies && dependency, `Unsupported generic dependency snapshot: ${line}`);
    dependencies.push(`${dependency[1] ?? dependency[2]}@${exactVersion(dependency[3])}`);
  }
  return dependencies;
}

function genericGraph(sourceLock, manifests, tooling) {
  const packages = entries(section(sourceLock, 'packages').body);
  const snapshots = entries(section(sourceLock, 'snapshots').body);
  const localNames = new Set(manifests.map(manifest => manifest.name));
  assert.deepEqual([...localNames].sort(), ['@arlo/adapter-sdk', '@arlo/daemon', '@arlo/sdk']);
  assert.equal(manifests.length, 3, 'Expected exactly three generic manifests');
  const wanted = new Set();
  function visit(id) {
    if (wanted.has(id)) return;
    assert.ok(packages.has(id) && snapshots.has(id), `Dependency absent from reviewed lock: ${id}`);
    const [name] = splitRegistryId(id);
    assert.doesNotMatch(name, /(?:^@deepseek-ai\/|cordis|^@arlo\/)/i, `Host dependency in generic graph: ${name}`);
    wanted.add(id);
    for (const dependency of snapshotDependencies(snapshots.get(id))) visit(dependency);
  }
  for (const manifest of [...manifests, { devDependencies: tooling }]) {
    assert.ok(!manifest.peerDependencies || Object.keys(manifest.peerDependencies).length === 0,
      'Generic peer dependencies require an explicit lock implementation');
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[group] ?? {})) {
        if (version === 'workspace:*') assert.ok(localNames.has(name), `Uncopied workspace dependency: ${name}`);
        else visit(`${name}@${exactVersion(version)}`);
      }
    }
  }
  return { packages, snapshots, wanted };
}

/** Frozen lock for copied, unmodified generic manifests and root build tooling. */
export function genericBuildLock(sourceLock, manifests, tooling) {
  const { packages, snapshots, wanted } = genericGraph(sourceLock, manifests, tooling);
  const importerSection = section(sourceLock, 'importers');
  const importers = entries(importerSection.body);
  const root = ['  .:', '    devDependencies:'];
  for (const [name, version] of Object.entries(tooling).sort(([a], [b]) => a.localeCompare(b))) {
    assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, 'Unsupported tooling package name');
    root.push(`      '${name}':`, `        specifier: ${exactVersion(version)}`, `        version: ${version}`);
  }
  const copiedImporters = manifests.map(manifest => {
    const name = `packages/${manifest.name.slice('@arlo/'.length)}`;
    assert.ok(importers.has(name), `Missing generic importer: ${name}`);
    return importers.get(name);
  });
  const selected = blocks => [...wanted].sort().map(id => blocks.get(id)).join('\n\n');
  if (/^patchedDependencies:/m.test(importerSection.prefix)) {
    for (const id of entries(section(sourceLock, 'patchedDependencies').body).keys()) {
      assert.ok(!wanted.has(id), 'Generic patched dependencies require an explicit lock implementation');
    }
  }
  // Host-only patches must not become installation requirements of the copied
  // generic graph, whose private root manifest intentionally has none.
  const genericPrefix = importerSection.prefix.replace(/^patchedDependencies:[ \t]*\n(?:[ \t][^\n]*\n|\n)*/m, '');
  return `${genericPrefix}importers:\n\n${[root.join('\n'), ...copiedImporters].join('\n\n')}\n\npackages:\n\n${selected(packages)}\n\nsnapshots:\n\n${selected(snapshots)}\n`;
}

/** Registry versions and integrity; local tarballs are audited separately. */
export function registryResolutions(lock) {
  const result = {};
  for (const [id, block] of entries(section(lock, 'packages').body)) {
    if (id.includes('@file:')) continue;
    const integrity = /^    resolution: \{integrity: (sha(?:1|256|384|512)-[A-Za-z0-9+/=]+)\}$/m.exec(block);
    assert.ok(integrity, `Expected reviewed registry integrity: ${id}`);
    result[id] = integrity[1];
  }
  return result;
}

/** Name overrides keep transitive ranges on the reviewed generic versions. */
export function pinnedOverrides(sourceLock, manifests, tooling) {
  const { wanted } = genericGraph(sourceLock, manifests, tooling);
  const result = {};
  for (const id of [...wanted].sort()) {
    const [name, version] = splitRegistryId(id);
    assert.ok(result[name] === undefined || result[name] === version,
      `Multiple generic versions require explicit overrides: ${name}`);
    result[name] = version;
  }
  return result;
}
