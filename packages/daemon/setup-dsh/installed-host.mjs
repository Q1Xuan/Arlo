import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileSha256 } from './exact-patch.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const reject = (code, guidance) => { const error = new Error(guidance); error.code = code; error.guidance = guidance; throw error; };
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };

export function installedPackage(require, name, owner) {
  for (const lookup of require.resolve.paths(name) ?? []) {
    const file = path.join(lookup, name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const directory = fs.realpathSync(path.dirname(file));
    if (!inside(path.join(owner, 'node_modules'), directory)) reject('DSH_DEPENDENCY_IDENTITY_MISMATCH', `The selected host resolves ${name} outside its verified installation owner.`);
    const manifest = json(path.join(directory, 'package.json'));
    if (manifest.name !== name || typeof manifest.version !== 'string') reject('DSH_DEPENDENCY_IDENTITY_MISMATCH', `The installed ${name} has a conflicting package identity.`);
    return { directory, version: manifest.version, manifestSha256: fileSha256(path.join(directory, 'package.json')) };
  }
  return null;
}

/** Identify the existing owner without requiring Arlo's prepared contracts.
 * A logical route survives pnpm's changed patch/peer physical snapshots. */
export function inspectDshInstallation(selected) {
  let directory, manifest, bin;
  try {
    directory = fs.realpathSync(typeof selected === 'string' ? selected : selected.packageDirectory);
    manifest = json(path.join(directory, 'package.json'));
    bin = fs.realpathSync(path.join(directory, manifest.bin.dsh));
    if (manifest.name !== '@deepseek-ai/dsh' || !['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'].includes(manifest.version)
      || !inside(directory, bin) || !bin.endsWith('.js') || !fs.statSync(bin).isFile()) throw new Error();
  } catch { return reject('HOST_UNSUPPORTED', 'Select the readable compiled @deepseek-ai/dsh package and its native bin.dsh. No host was downloaded or replaced.'); }
  const parts = directory.split(path.sep);
  const virtual = parts.indexOf('.pnpm');
  const boundary = virtual >= 0 ? virtual - 1 : parts.lastIndexOf('node_modules');
  if (boundary < 0 || parts[boundary] !== 'node_modules') reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'An unmanaged or redirected source tree cannot prove the selected DSH installation owner. Preserve it and locate its standard package installation.');
  const owner = parts.slice(0, boundary).join(path.sep) || path.parse(directory).root;
  const packageDirectory = path.join(owner, 'node_modules', '@deepseek-ai/dsh');
  const ownerFile = path.join(owner, 'package.json');
  const modulesFile = path.join(owner, 'node_modules/.modules.yaml');
  const pnpmFile = path.join(owner, 'pnpm-lock.yaml');
  const npmFile = ['npm-shrinkwrap.json', 'package-lock.json'].map(name => path.join(owner, name)).find(file => fs.existsSync(file));
  if (!fs.existsSync(ownerFile)) reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'This is an npm global or unmanaged owner without an audited locked preparation scope. The selected prefix and startup route remain unchanged; automatic preparation currently supports existing locked local npm and isolated pnpm owners.');
  for (const file of [ownerFile, modulesFile, pnpmFile, npmFile].filter(Boolean)) {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'The selected package-manager metadata is redirected. Resolve its actual installation owner before setup.');
  }
  if (fs.lstatSync(path.join(owner, 'node_modules')).isSymbolicLink() || fs.realpathSync(owner) !== owner
    || fs.realpathSync(packageDirectory) !== directory) reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'The selected package route is not owned by this normal installation. No second DSH is acquired.');
  const ownerManifest = json(ownerFile);
  const declared = ownerManifest.packageManager;
  const pnpm = fs.existsSync(modulesFile) || fs.existsSync(pnpmFile);
  if (pnpm && npmFile || declared !== undefined && !/^(npm|pnpm)@\d+\.\d+\.\d+(?:\+sha(?:224|256|512)\.[a-f0-9]+)?$/.test(declared)
    || declared?.startsWith('npm@') && pnpm || declared?.startsWith('pnpm@') && npmFile) reject('PACKAGE_MANAGER_CONFLICT', 'The selected DSH owner has conflicting package-manager declarations or locks. Preserve them and reconcile through that owner.');
  const hostRequire = createRequire(path.join(directory, 'package.json'));
  let managerVersion, storeDirectory, lock, lockFile;
  if (pnpm) {
    if (!fs.existsSync(pnpmFile) || !fs.existsSync(modulesFile)) reject('PACKAGE_MANAGER_CONFLICT', 'The selected pnpm owner needs both its actual lock and installed module metadata.');
    const yaml = hostRequire('js-yaml');
    const modules = yaml.load(fs.readFileSync(modulesFile, 'utf8'));
    managerVersion = modules.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
    if (!managerVersion || declared && declared.split('@')[1].split('+')[0] !== managerVersion) reject('PACKAGE_MANAGER_CONFLICT', 'The exact installed pnpm tool and owner declaration disagree. Setup does not guess another manager.');
    lock = yaml.load(fs.readFileSync(pnpmFile, 'utf8'));
    if (modules.nodeLinker !== 'isolated' || modules.virtualStoreDir !== '.pnpm' || modules.layoutVersion !== 5
      || fs.existsSync(path.join(owner, 'pnpm-workspace.yaml')) || Object.keys(lock.importers ?? {}).join(',') !== '.'
      || !['9', '9.0'].includes(String(lock.lockfileVersion))) reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'Automatic DSH preparation supports a single local pnpm v9 importer, isolated nodeLinker and the standard .pnpm virtual store. This workspace/custom layout is preserved.');
    if (typeof modules.storeDir !== 'string' || !path.isAbsolute(modules.storeDir) || !/^v\d+$/.test(path.basename(modules.storeDir))) reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'The selected pnpm owner has no verifiable native versioned store directory. Its modules were preserved.');
    storeDirectory = path.dirname(modules.storeDir);
    const root = { ...lock.importers['.'].dependencies, ...lock.importers['.'].devDependencies, ...lock.importers['.'].optionalDependencies }['@deepseek-ai/dsh'];
    if (!root || root.version.split('(')[0] !== manifest.version) reject('DSH_DEPENDENCY_IDENTITY_MISMATCH', 'The selected DSH package is not the installed version recorded by this importer.');
    lockFile = pnpmFile;
  } else {
    if (!npmFile) reject('DSH_INSTALLATION_LAYOUT_UNSUPPORTED', 'Automatic npm preparation requires the selected existing local owner and its native package-lock or shrinkwrap. No global project or lock is fabricated.');
    lock = json(npmFile);
    if (![2, 3].includes(lock.lockfileVersion) || lock.packages?.['node_modules/@deepseek-ai/dsh']?.version !== manifest.version
      || lock.packages['node_modules/@deepseek-ai/dsh'].link) reject('DSH_DEPENDENCY_IDENTITY_MISMATCH', 'The native npm lock does not prove this exact selected DSH package. Preserve the owner and reconcile it through npm.');
    lockFile = npmFile;
  }
  const selector = { owner, packageDirectory, packageName: '@deepseek-ai/dsh', importer: '.', manager: pnpm ? 'pnpm' : 'npm', lockFile: path.basename(lockFile) };
  if (typeof selected !== 'string' && JSON.stringify(selected) !== JSON.stringify(selector)) reject('DSH_INSTALLATION_IDENTITY_CONFLICT', 'The retained logical DSH selector no longer describes this exact native owner. Preserve the records and review the original startup route.');
  const dependencies = { ...ownerManifest.devDependencies, ...ownerManifest.optionalDependencies, ...ownerManifest.dependencies };
  if (typeof dependencies['@deepseek-ai/dsh'] !== 'string') reject('DSH_DEPENDENCY_IDENTITY_MISMATCH', 'The selected package is not declared by this installation owner.');
  const evidence = Object.fromEntries([ownerFile, lockFile, modulesFile, path.join(owner, 'node_modules/.package-lock.json'), path.join(directory, 'package.json'), bin]
    .map(file => [file, fileSha256(file)]));
  return { family: 'dsh', selector, directory, version: manifest.version, bin, owner, manager: selector.manager,
    ...(managerVersion ? { managerVersion } : {}), ...(storeDirectory ? { storeDirectory } : {}), peers: {}, evidence };
}

export function dshBorrowedModules(host, names, allowMissing = false) {
  const require = createRequire(path.join(host.directory, 'package.json'));
  const peers = {};
  for (const name of names) {
    const identity = name === '@deepseek-ai/dsh'
      ? { directory: host.directory, version: host.version, manifestSha256: fileSha256(path.join(host.directory, 'package.json')) }
      : installedPackage(require, name, host.owner);
    if (!identity && !allowMissing) reject('DSH_REQUIRED_MODULE_MISSING', `The selected DSH installation is missing the required ${name}; native registration did not run.`);
    if (identity) peers[name] = identity;
  }
  return { ...host, peers };
}
