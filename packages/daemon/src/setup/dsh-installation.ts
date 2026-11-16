import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSafeStatePath, enforceWindowsAcl, verifyWindowsAcl } from '@arlo/sdk';
import { componentDataDirectory, npmCli, prepareHostComponents } from './components.ts';
import { fail, SetupError } from './errors.ts';
import { assertConfigurationFile, persistSetupRecord, setupTransaction } from './transaction.ts';
import { inspectDshHostPreparation } from '../../setup-dsh/host-preparation.mjs';
import { inspectDshInstallation, installedPackage, dshBorrowedModules, type DshInstalledHost } from '../../setup-dsh/installed-host.mjs';
import { canonicalSha256, inspectDshBoundHostDependencyClosure } from '../../setup-dsh/dependency-closure.mjs';
import { sha256, fileSha256, packageInventory, readExactPatch, applyExactHunks, replaceOwnedFile } from '../../setup-dsh/exact-patch.mjs';

const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const releaseCatalog = json(fileURLToPath(new URL('../../package.json', import.meta.url))).arlo;
const reviewedHosts = json(fileURLToPath(new URL('../../setup-dsh/reviewed-hosts.json', import.meta.url)));
const materialDirectory = fileURLToPath(new URL('../../setup-dsh/preparation-material/', import.meta.url));
export const dshKnownAdapterNames = [...new Set(['@arlo/adapter-dsh', ...Object.values(releaseCatalog?.dshAdapters ?? {}).map((entry: any) => entry.name)])];
export const dshBorrowedNames = ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-modules'];

function release(hostVersion: string) {
  const entries = ['sdk', 'adapterSdk', 'daemon'].map(role => releaseCatalog?.components?.[role]);
  const adapter = releaseCatalog?.dshAdapters?.[hostVersion];
  entries.push(adapter);
  if (entries.some(entry => typeof entry?.name !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(entry?.version ?? ''))) {
    fail('COMPONENT_CATALOG_UNAVAILABLE', 'Obtain the compiled coordinated CLI with exact components for this DSH version. No component or host was changed.');
  }
  return { packages: Object.fromEntries(entries.map(entry => [entry.name, entry.version])) as Record<string, string>, adapterName: adapter.name as string };
}
function routing(manifest: any): string {
  return sha256(JSON.stringify(Object.fromEntries(['type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh']
    .filter(field => field in manifest).map(field => [field, manifest[field]]))));
}
function browserFiles(directory: string, relative = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(files, browserFiles(directory, name));
    else if (entry.isFile()) files[name] = fileSha256(path.join(directory, name));
    else fail('DSH_RESOURCE_MISMATCH', 'The embedded browser inventory contains a redirected or unknown resource. Preserve it before preparing this host.');
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
function unchangedPnpmGraph(before: any, after: any, added: string[], patches: string[]): Set<string> {
  const pairs = new Map<string, { beforeId: string; afterId: string; children: Set<string>; repaired: boolean }>();
  const covered = new Set<string>();
  const mapped = new Set<string>();
  const pair = (name: string, original: string, planned: string): string | undefined => {
    if (/^(link:|file:)/.test(original)) {
      if (original !== planned) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan redirects an unrelated local dependency. No target changed.');
      return;
    }
    const beforeId = `${name}@${original}`, afterId = `${name}@${planned}`;
    if (original.split('(')[0] !== planned.split('(')[0]) fail('DSH_PACKAGE_PLAN_CONFLICT', `The pnpm plan changes the installed version of ${name}. No target changed.`);
    const key = `${beforeId}\0${afterId}`;
    if (pairs.has(key)) return key;
    const oldNode = before.snapshots[beforeId], newNode = after.snapshots[afterId];
    if (!oldNode || !newNode) fail('DSH_PACKAGE_PLAN_CONFLICT', `The pnpm plan cannot preserve the exact dependency graph for ${name}. No target changed.`);
    const oldHash = original.match(/\(patch_hash=([^)]+)\)/)?.[1];
    const newHash = planned.match(/\(patch_hash=([^)]+)\)/)?.[1];
    const packageId = beforeId.split('(')[0];
    const repaired = oldHash !== newHash && patches.includes(packageId) && newHash === after.patchedDependencies?.[packageId]?.hash;
    if (oldHash !== newHash && !repaired) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes a patch hash outside the reviewed owned transition. User patches were preserved.');
    const state = { beforeId, afterId, children: new Set<string>(), repaired };
    pairs.set(key, state); covered.add(beforeId); mapped.add(afterId);
    const oldMetadata = { ...oldNode }, newMetadata = { ...newNode };
    for (const field of ['dependencies', 'optionalDependencies']) {
      const originalEdges = oldNode[field] ?? {}, plannedEdges = { ...(newNode[field] ?? {}) };
      if (name === '@deepseek-ai/dsh' && field === 'dependencies') for (const dependency of added) delete plannedEdges[dependency];
      if (Object.keys(originalEdges).sort().join(',') !== Object.keys(plannedEdges).sort().join(',')) fail('DSH_PACKAGE_PLAN_CONFLICT', `The pnpm plan changes required/optional or peer edges for ${name}. No target changed.`);
      for (const dependency of Object.keys(originalEdges)) {
        const child = pair(dependency, originalEdges[dependency], plannedEdges[dependency]);
        if (child) state.children.add(child);
      }
      delete oldMetadata[field]; delete newMetadata[field];
    }
    if (canonicalSha256(oldMetadata) !== canonicalSha256(newMetadata)) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes an existing snapshot outside its reviewed repair references. No target changed.');
    return key;
  };
  const originalImporter = structuredClone(before.importers['.']), plannedImporter = structuredClone(after.importers['.']);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const original = originalImporter[field] ?? {}, planned = plannedImporter[field] ?? {};
    if (Object.keys(original).sort().join(',') !== Object.keys(planned).sort().join(',')) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes an unrelated importer declaration. No target changed.');
    for (const name of Object.keys(original)) {
      pair(name, original[name].version, planned[name].version);
      planned[name].version = original[name].version;
    }
  }
  if (canonicalSha256(originalImporter) !== canonicalSha256(plannedImporter)) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes an unrelated owner declaration or dependency selector. No target changed.');
  // pnpm abbreviates large peer contexts with opaque hashes. A changed context
  // is accepted only after pairing all exact versions/edges and proving a
  // reviewed patch is reachable; opaque hash stripping is not identity proof.
  let progress = true;
  while (progress) {
    progress = false;
    for (const state of pairs.values()) if (!state.repaired && [...state.children].some(key => pairs.get(key)!.repaired)) { state.repaired = true; progress = true; }
  }
  for (const state of pairs.values()) if (state.beforeId !== state.afterId && !state.repaired) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes a physical peer context without a reviewed repair transition. No target changed.');
  const newReachable = new Set<string>();
  const visit = (name: string, reference: string) => {
    const id = `${name}@${reference}`;
    if (newReachable.has(id)) return;
    newReachable.add(id); newReachable.add(id.split('(')[0]);
    const snapshot = after.snapshots[id];
    if (!snapshot) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan lacks a reachable browser supplement snapshot. No owner changed.');
    for (const [dependency, target] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) visit(dependency, target as string);
  };
  const hostReference = { ...after.importers['.'].dependencies, ...after.importers['.'].devDependencies, ...after.importers['.'].optionalDependencies }['@deepseek-ai/dsh'].version;
  for (const name of added) visit(name, after.snapshots[`@deepseek-ai/dsh@${hostReference}`].dependencies[name]);
  for (const [id, record] of Object.entries(before.packages)) if (!Object.hasOwn(after.packages, id) || canonicalSha256(record) !== canonicalSha256(after.packages[id])) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan would change an existing package version, registry resolution or integrity. No owner changed.');
  for (const id of Object.keys(after.packages)) if (!Object.hasOwn(before.packages, id) && !newReachable.has(id)) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan acquires a package outside the necessary browser supplements. No owner changed.');
  for (const [id, record] of Object.entries(before.snapshots)) if (!covered.has(id)) {
    if (!Object.hasOwn(after.snapshots, id) || canonicalSha256(record) !== canonicalSha256(after.snapshots[id])) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes an unrelated retained snapshot. No owner changed.');
    mapped.add(id);
  }
  for (const id of Object.keys(after.snapshots)) if (!mapped.has(id) && !newReachable.has(id)) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan creates an unrelated peer snapshot or a second host. No owner changed.');
  const original = structuredClone(before), planned = structuredClone(after);
  for (const field of ['packages', 'snapshots', 'importers']) { delete original[field]; delete planned[field]; }
  if (added.length) { delete original.packageExtensionsChecksum; delete planned.packageExtensionsChecksum; }
  for (const selector of patches) delete planned.patchedDependencies?.[selector];
  if (!Object.keys(planned.patchedDependencies ?? {}).length) delete planned.patchedDependencies;
  if (canonicalSha256(original) !== canonicalSha256(planned)) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The pnpm plan changes unrelated settings or existing patch records. Preserve those records and reconcile the selected owner.');
  return new Set([...pairs.values()].filter(pair => pair.beforeId !== pair.afterId).map(pair => pair.beforeId.split('(')[0]));
}

type PreparationRecord = {
  schemaVersion: 1; kind: 'dsh-preparation'; id: string; root: string; selector: DshInstalledHost['selector']; version: string;
  materialSha256: string; manager: { name: 'npm' | 'pnpm'; version: string; args: string[] };
  phase: 'intent' | 'materials-written' | 'owner-prepared' | 'native-preparing' | 'native-prepared' | 'verified' | 'configured';
  ownerKeys: { path: string[]; after: unknown; phase: 'pending' | 'applied' }[];
  createdContainers: string[][]; lock: { beforeSha256: string; afterSha256: string; phase: 'pending' | 'applied' };
  files: { name: string; packageName: string; file: string; beforeDirectory: string; directory?: string;
    beforeSha256: string; afterSha256: string; owned: boolean; phase: 'pending' | 'applied' | 'borrowed' }[];
  patches: { selector: string; file: string; sha256: string; owned: boolean; phase: 'pending' | 'written' | 'borrowed' }[];
  packages: { name: string; version: string; owned: boolean; directory?: string; inventory?: Record<string, string> }[];
  references: Record<string, { target: string; phase: 'prepared' | 'configured' }>;
  beforeIdentity: Record<string, string>; afterIdentity?: Record<string, string>; createdAt: string;
  failure?: { code: string; phase: string; exit: number | null; signal: string | null };
};
function preparationRecord(root: string, selector: DshInstalledHost['selector'], id: string, version: string, materialSha256: string): PreparationRecord | undefined {
  const file = path.join(root, 'preparation.json');
  if (!fs.existsSync(file)) return;
  assertSafeStatePath(root);
  if (fs.lstatSync(file).isSymbolicLink() || !verifyWindowsAcl(file).valid) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The private preparation record is unsafe. Preserve it and review the selected installation.');
  let record;
  try { record = json(file); } catch { return fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The private preparation record is unreadable. Preserve it; no old package or configuration snapshot is restored.'); }
  if (record?.schemaVersion !== 1 || record.kind !== 'dsh-preparation' || record.root !== root || record.id !== id
    || JSON.stringify(record.selector) !== JSON.stringify(selector) || record.version !== version || record.materialSha256 !== materialSha256
    || !['intent', 'materials-written', 'owner-prepared', 'native-preparing', 'native-prepared', 'verified', 'configured'].includes(record.phase)
    || !Array.isArray(record.ownerKeys) || !Array.isArray(record.createdContainers) || !Array.isArray(record.files)
    || !Array.isArray(record.patches) || !Array.isArray(record.packages) || !record.references || !record.beforeIdentity
    || [...record.files, ...record.patches, ...record.packages].some(entry => !entry || typeof entry.owned !== 'boolean')
    || !record.lock || !/^[a-f0-9]{64}$/.test(record.lock.beforeSha256) || !/^[a-f0-9]{64}$/.test(record.lock.afterSha256)) {
    fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The retained record does not prove this exact preparation. Preserve its files and the selected owner for review.');
  }
  return record;
}
const atKey = (value: any, keys: string[]): any => keys.reduce((current, key) => current?.[key], value);
function setKey(value: any, keys: string[], next: unknown): void {
  let parent = value;
  for (const key of keys.slice(0, -1)) {
    if (parent[key] !== undefined && (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key]))) fail('DSH_PACKAGE_PLAN_CONFLICT', 'An existing owner setting conflicts with the precise native preparation key. It was preserved.');
    parent = parent[key] ??= {};
  }
  parent[keys.at(-1)!] = next;
}

/** A failed native tool can leave the original package link missing. This
 * checkpoint reports owned intent; it never substitutes a Host identity. */
export function inspectDshPreparationRecovery(target: string) {
  const parent = path.join(componentDataDirectory(), 'preparations');
  if (!fs.existsSync(parent)) return;
  assertSafeStatePath(parent);
  const selected = path.resolve(target);
  const matches = fs.readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) return [];
    const root = path.join(parent, entry.name), file = path.join(root, 'preparation.json');
    let hint;
    try { assertSafeStatePath(root); assertConfigurationFile(file); hint = json(file); } catch { return []; }
    if (hint?.selector?.packageDirectory !== selected || !['intent', 'materials-written', 'owner-prepared', 'native-preparing', 'native-prepared'].includes(hint.phase)) return [];
    const selector = hint.selector;
    if (typeof selector.owner !== 'string' || !path.isAbsolute(selector.owner) || fs.realpathSync(selector.owner) !== selector.owner
      || selected !== path.join(selector.owner, 'node_modules/@deepseek-ai/dsh') || selector.packageName !== '@deepseek-ai/dsh'
      || selector.importer !== '.' || !['npm', 'pnpm'].includes(selector.manager)
      || !['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml'].includes(selector.lockFile)
      || !['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'].includes(hint.version)) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The retained recovery selector is ambiguous. Preserve its record and original native owner.');
    const materialFile = path.join(materialDirectory, hint.version, 'material.json');
    if (!fs.existsSync(materialFile)) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The retained recovery has no matching bundled preparation material. Preserve the native owner and record.');
    const materialSha256 = fileSha256(materialFile);
    const id = sha256(JSON.stringify({ selector, version: hint.version, materialSha256 }));
    const record = preparationRecord(root, selector, id, hint.version, materialSha256)!;
    const ownerFile = path.join(selector.owner, 'package.json'), lockFile = path.join(selector.owner, selector.lockFile);
    assertConfigurationFile(ownerFile); assertConfigurationFile(lockFile);
    const owner = json(ownerFile);
    if (fs.lstatSync(path.join(selector.owner, 'node_modules')).isSymbolicLink() || !['pending', 'applied'].includes(record.lock.phase)
      || fileSha256(lockFile) !== (record.lock.phase === 'applied' ? record.lock.afterSha256 : record.lock.beforeSha256)
      || record.ownerKeys.some(key => !Array.isArray(key.path) || !key.path.length || !['pending', 'applied'].includes(key.phase)
        || key.phase === 'applied' && canonicalSha256(atKey(owner, key.path)) !== canonicalSha256(key.after))
      || record.failure && (typeof record.failure.code !== 'string' || record.failure.phase !== record.phase
        || record.failure.exit !== null && !Number.isInteger(record.failure.exit)
        || record.failure.signal !== null && typeof record.failure.signal !== 'string')) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The interrupted native owner or its precise recovery keys changed. Preserve those edits and the retained record before retrying.');
    const batch = release(record.version);
    const componentId = sha256(JSON.stringify({ selector, version: record.version, materialSha256, packages: batch.packages }));
    const componentRoot = path.join(componentDataDirectory(), 'installations', componentId);
    return [{ target: { directory: selected, version: record.version, owner: selector.owner,
      installation: fs.existsSync(selected) ? 'requires-verification' : 'missing' },
      preparation: { state: 'recovery-required', id, directory: root, selector, materialSha256,
        transaction: record.phase, manager: { name: record.manager.name, version: record.manager.version },
        ...(record.failure ? { failure: record.failure } : {}) },
      components: { id: componentId, directory: componentRoot, state: fs.existsSync(componentRoot) ? 'unobserved' : 'missing' },
      nextStep: `Restore the native owner's access, then finish its existing prepared lock through ${record.manager.name}@${record.manager.version} in ${selector.owner}. Use a frozen install with scripts disabled; preserve its current declarations and bundled patch files. Retry the same setup selection afterward. No old package tree or profile snapshot is restored.` }];
  });
  if (matches.length > 1) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'More than one unfinished preparation names this native owner. Preserve both records and review their exact phases before retrying.');
  return matches[0];
}

/** Version-specific preparation is hidden behind the installation plan. The
 * public CLI is the only test seam; no synthetic host readiness is accepted. */
export async function planDshInstallation(target: string, profileDir: string, selectedNpm?: string, experimental = false, mode: 'install' | 'inspect' = 'install') {
  let stage: string | undefined;
  let components: Awaited<ReturnType<typeof prepareHostComponents>> | undefined;
  let preparationRelease: (() => Promise<void>) | undefined;
  try {
    const initial = inspectDshInstallation(target);
    const materialFile = path.join(materialDirectory, initial.version, 'material.json');
    if (!fs.existsSync(materialFile)) fail('DSH_AUTOMATIC_PREPARATION_UNAVAILABLE', 'This compiled release has no reviewed automatic preparation material for the selected DSH version. Its installation and profile remain unchanged.');
    const material = json(materialFile);
    const materialSha256 = fileSha256(materialFile);
    const batch = release(initial.version);
    const preparationId = sha256(JSON.stringify({ selector: initial.selector, version: initial.version, materialSha256 }));
    const root = path.join(componentDataDirectory(), 'preparations', preparationId);
    const resourceId = sha256(JSON.stringify({ selector: initial.selector, version: initial.version, materialSha256, packages: batch.packages }));
    let record = preparationRecord(root, initial.selector, preparationId, initial.version, materialSha256);
    if (!record && fs.existsSync(root)) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'An unrecorded preparation resource already exists. Preserve it for review; setup cannot claim its files.');
    const reviewed = reviewedHosts[initial.version];
    const require = createRequire(path.join(initial.directory, 'package.json'));
    if (material.schemaVersion !== 1 || material.hostVersion !== initial.version || !reviewed || material.repairs.length !== 5) fail('DSH_MATERIAL_INVALID', 'Obtain an intact version-specific compiled preparation release. No host was changed.');
    const repairs = material.repairs.map((repair: any) => {
      const patch = fs.readFileSync(path.join(materialDirectory, initial.version, repair.patch));
      if (sha256(patch) !== repair.sha256 || reviewed.patches[repair.patch] !== repair.sha256 || repair.version !== initial.version) fail('DSH_MATERIAL_INVALID', 'The bundled patch identity differs from the reviewed exact version material. No host was changed.');
      const identity = installedPackage(require, repair.packageName, initial.owner);
      if (!identity || identity.version !== initial.version) fail('DSH_PACKAGE_MISMATCH', 'The selected host has a mixed program family. No repair or upgrade was applied.');
      const parsed = readExactPatch(patch);
      const files = repair.files.map((entry: any) => {
        const actual = fileSha256(path.join(identity.directory, entry.file));
        const state = actual === entry.beforeSha256 ? 'unprepared' : actual === entry.afterSha256 ? 'prepared' : 'conflict';
        if (state === 'conflict') fail('DSH_PROGRAM_CHANGE_CONFLICT', `The exact ${repair.name}/${entry.file} preimage is unknown or edited. Preserve it; automatic preparation did not overwrite it.`);
        const hunk = parsed.find(entryPatch => entryPatch.file === entry.file);
        if (!hunk || reviewed.packages[repair.packageName].files[entry.file] !== entry.afterSha256
          || state === 'unprepared' && sha256(applyExactHunks(fs.readFileSync(path.join(identity.directory, entry.file)), hunk.hunks)) !== entry.afterSha256) fail('DSH_MATERIAL_INVALID', 'The exact bundled recipe cannot reproduce its reviewed postimage. No target changed.');
        return { ...entry, state };
      });
      if (new Set(files.map((entry: any) => entry.state)).size !== 1 && !record) fail('DSH_PREPARATION_RECOVERY_REQUIRED', 'This host has a mixed partial repair. Preserve its preparation record and review the completed file phases before retrying.');
      return { ...repair, directory: identity.directory, files, state: files.every((file: any) => file.state === 'prepared') ? 'prepared' : 'unprepared' };
    });
    for (const [name, expected] of Object.entries(reviewed.packages) as [string, any][]) {
      const identity = installedPackage(require, name, initial.owner);
      if (!identity && Object.hasOwn(material.supplements, name)) continue;
      if (!identity || identity.version !== expected.version || routing(json(path.join(identity.directory, 'package.json'))) !== expected.routingSha256) fail('DSH_ENTRY_MISMATCH', `The selected ${name} version or entry routing differs from the reviewed host. No target changed.`);
      const inventory = packageInventory(identity.directory);
      const original = material.packageInventories[`${name}@${identity.version}`];
      if (!original || Object.keys(original).join(',') !== Object.keys(inventory).join(',')) fail('DSH_PROGRAM_CHANGE_CONFLICT', `The selected ${name} contains an unknown package inventory. Preserve its added or edited files before preparation.`);
      for (const [file, digest] of Object.entries(inventory)) {
        const repair = repairs.find((entry: any) => entry.packageName === name)?.files.find((entry: any) => entry.file === file);
        if (digest !== original[file] && (!repair || digest !== repair.afterSha256)) fail('DSH_PROGRAM_CHANGE_CONFLICT', `The selected ${name}/${file} contains an existing user edit. Preserve it; native rematerialization is not authorized to replace it.`);
      }
    }
    const frontend = installedPackage(require, '@deepseek-ai/dsh-web-frontend', initial.owner)!;
    if (canonicalSha256(browserFiles(path.join(frontend.directory, 'dist'))) !== canonicalSha256(reviewed.frontend.files)) fail('DSH_RESOURCE_MISMATCH', 'The complete embedded browser inventory or entry differs from the reviewed rc.5 material. No host changed.');
    const closure = inspectDshBoundHostDependencyClosure(initial);
    for (const [id, digest] of Object.entries(closure.manifestRouting)) if (Object.hasOwn(reviewed.dependencyManifests, id) && reviewed.dependencyManifests[id] !== digest) fail('DSH_DEPENDENCY_IDENTITY_MISMATCH', 'An installed dependency has a changed reviewed manifest selector or required peer identity. No host changed.');
    if (!experimental && closure.lockSha256 !== reviewed.hostDependencyClosureSha256) fail('DSH_EXPERIMENTAL_REQUIRED', 'This ordinary dependency profile differs from the historical complete recipe. Use explicit --experimental to evaluate the exact installed profile; critical identities, peers, patches and browser gates remain mandatory.');
    const manifestFile = path.join(initial.owner, 'package.json');
    const beforeManifest = json(manifestFile);
    const plannedManifest = structuredClone(beforeManifest);
    const ownerKeys: PreparationRecord['ownerKeys'] = [];
    const createdContainers: string[][] = [];
    const addKey = (keys: string[], value: unknown) => {
      if (atKey(beforeManifest, keys) !== undefined) fail('DSH_PACKAGE_PLAN_CONFLICT', 'An existing native dependency/patch/extension key overlaps this preparation. Its value was preserved.');
      for (let length = 1; length < keys.length; length++) if (atKey(beforeManifest, keys.slice(0, length)) === undefined
        && !createdContainers.some(entry => entry.join('\0') === keys.slice(0, length).join('\0'))) createdContainers.push(keys.slice(0, length));
      setKey(plannedManifest, keys, value); ownerKeys.push({ path: keys, after: value, phase: 'pending' });
    };
    const added = Object.keys(material.supplements).filter(name => !installedPackage(require, name, initial.owner));
    for (const name of added) {
      if ({ ...beforeManifest.dependencies, ...beforeManifest.optionalDependencies, ...beforeManifest.devDependencies }[name] !== undefined) fail('DSH_PACKAGE_PLAN_CONFLICT', 'A missing required browser package already has an owner declaration. Reconcile the original package installation; setup will not replace that declaration.');
      if (initial.manager === 'npm') addKey(['dependencies', name], material.supplements[name]);
      else {
        const exact = `@deepseek-ai/dsh@${initial.version}`;
        for (const [selector, extension] of Object.entries(beforeManifest.pnpm?.packageExtensions ?? {}) as [string, any][]) {
          if ((selector === '@deepseek-ai/dsh' || selector.startsWith('@deepseek-ai/dsh@')) && extension.dependencies?.[name] !== undefined) fail('DSH_PACKAGE_PLAN_CONFLICT', 'An existing DSH package extension overlaps a missing browser supplement. Preserve it and reconcile the native installation first.');
        }
        addKey(['pnpm', 'packageExtensions', exact, 'dependencies', name], material.supplements[name]);
      }
    }
    const npm = npmCli(selectedNpm);
    const manager = initial.manager === 'pnpm' ? { name: 'pnpm' as const, version: initial.managerVersion!, args: [npm, 'exec', '--yes', '--ignore-scripts', `--package=pnpm@${initial.managerVersion}`, '--', 'pnpm'] }
      : { name: 'npm' as const, version: spawnSync(process.execPath, [npm, '--version'], { encoding: 'utf8', timeout: 15_000 }).stdout.trim(), args: [npm] };
    const execute = (args: string[], cwd: string) => spawnSync(process.execPath,
      [manager.args[0], '--global=false', `--prefix=${cwd}`, ...manager.args.slice(1), ...args,
        ...(manager.name === 'pnpm' ? [`--dir=${cwd}`, '--global=false', `--store-dir=${initial.storeDirectory}`] : [])],
      { cwd, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    stage = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-preparation-plan-')); enforceWindowsAcl(stage, true);
    const yaml = require('js-yaml');
    const lockFile = path.join(initial.owner, initial.selector.lockFile);
    const beforeLock = fs.readFileSync(lockFile, 'utf8');
    const newPatches: string[] = [];
    if (manager.name === 'pnpm') {
      plannedManifest.pnpm ??= {};
      const declarations = plannedManifest.pnpm.patchedDependencies ??= {};
      for (const repair of repairs) {
        const selector = `${repair.packageName}@${repair.version}`;
        const effective = Object.keys(declarations).filter(key => key === repair.packageName || key.startsWith(`${repair.packageName}@`)
          && (key === selector || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(key.slice(repair.packageName.length + 1))));
        const ownedPending = record?.ownerKeys.some(entry => entry.path.join('\0') === ['pnpm', 'patchedDependencies', selector].join('\0') && entry.after === declarations[selector]);
        if (effective.length && (effective.length !== 1 || effective[0] !== selector
          || fileSha256(path.resolve(initial.owner, declarations[selector])) !== repair.sha256 || repair.state !== 'prepared' && !ownedPending)) fail('DSH_EXISTING_PATCH_CONFLICT', `An existing effective patch for ${repair.name} differs from the reviewed material. Its declaration and files were preserved.`);
        if (!effective.length) { addKey(['pnpm', 'patchedDependencies', selector], path.relative(initial.owner, path.join(root, 'patches', repair.patch)).replaceAll(path.sep, '/')); newPatches.push(selector); }
      }
      const staged = structuredClone(plannedManifest);
      for (const [selector, file] of Object.entries(staged.pnpm.patchedDependencies) as [string, string][]) {
        const repair = repairs.find((entry: any) => `${entry.packageName}@${entry.version}` === selector);
        const bytes = repair && newPatches.includes(selector) ? fs.readFileSync(path.join(materialDirectory, initial.version, repair.patch)) : fs.readFileSync(path.resolve(initial.owner, file));
        const local = `patches/${sha256(bytes)}.patch`; fs.mkdirSync(path.join(stage, 'patches'), { recursive: true }); fs.writeFileSync(path.join(stage, local), bytes);
        staged.pnpm.patchedDependencies[selector] = local;
      }
      fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(staged, null, 2));
    } else fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(plannedManifest, null, 2));
    fs.writeFileSync(path.join(stage, initial.selector.lockFile), beforeLock);
    const unchanged = !added.length && !newPatches.length && repairs.every((repair: any) => repair.state === 'prepared');
    if (mode === 'inspect' && !unchanged) fail('DSH_PREPARATION_RECOVERY_REQUIRED', 'The selected ordinary host is not fully prepared. Inspect its retained preparation phases or preview setup; no program or profile changed.');
    if (!unchanged) {
      const result = execute(manager.name === 'pnpm' ? ['install', '--lockfile-only', '--ignore-scripts', '--ignore-workspace', '--prefer-offline']
        : ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
      if (result.status !== 0 || result.error) fail('DSH_PACKAGE_PLAN_FAILED', `The exact native ${manager.name} preparation plan failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code}, signal ${result.signal ?? 'none'}). No installation or profile changed.`);
    }
    let lockBytes: string;
    let affected = new Set<string>();
    if (unchanged) lockBytes = beforeLock;
    else if (manager.name === 'pnpm') {
      const planned = yaml.load(fs.readFileSync(path.join(stage, initial.selector.lockFile), 'utf8'));
      for (const [selector, record] of Object.entries(planned.patchedDependencies ?? {}) as [string, any][]) record.path = plannedManifest.pnpm.patchedDependencies[selector];
      const ownedPatches = record?.ownerKeys.filter(entry => entry.path[0] === 'pnpm' && entry.path[1] === 'patchedDependencies').map(entry => entry.path[2]) ?? [];
      affected = unchangedPnpmGraph(yaml.load(beforeLock), planned, added, [...newPatches, ...ownedPatches]);
      lockBytes = yaml.dump(planned, { lineWidth: -1, noRefs: true });
    } else {
      const original = JSON.parse(beforeLock), planned = json(path.join(stage, initial.selector.lockFile));
      for (const [key, record] of Object.entries(original.packages)) if (key && canonicalSha256(record) !== canonicalSha256(planned.packages[key])) fail('DSH_PACKAGE_PLAN_CONFLICT', 'The native npm plan would change an existing locked dependency. Its versions and unrelated declarations were preserved.');
      lockBytes = JSON.stringify(planned, null, 2) + '\n';
    }
    const affectedInventories: Record<string, Record<string, string>> = {};
    for (const [directory, id] of Object.entries(closure.installedDirectories)) if (affected.has(id)) {
      const inventory = packageInventory(directory), expected = material.packageInventories[id];
      if (!expected || Object.keys(inventory).join(',') !== Object.keys(expected).join(',')) fail('DSH_PROGRAM_CHANGE_CONFLICT', 'An affected native package has an unknown inventory. Its files were preserved before rematerialization.');
      for (const [file, actual] of Object.entries(inventory)) {
        const repairFile = repairs.find((repair: any) => `${repair.packageName}@${repair.version}` === id)?.files.find((entry: any) => entry.file === file);
        if (actual !== expected[file] && (!repairFile || actual !== repairFile.afterSha256)) fail('DSH_PROGRAM_CHANGE_CONFLICT', `The affected ${id}/${file} contains a later edit. It was preserved; native rematerialization did not run.`);
      }
      affectedInventories[directory] = inventory;
    }
    let host = dshBorrowedModules(initial, dshBorrowedNames, true);
    const bindingFor = (current: DshInstalledHost, allowMissing: boolean) => ({ host: current, target: initial.selector.packageDirectory, ...batch, resourceId,
      deployment: { materialSha256, experimentalCompatibility: experimental },
      recheck: () => dshBorrowedModules(inspectDshInstallation(initial.selector), dshBorrowedNames, allowMissing),
      yaml: { parse: yaml.load, stringify: (value: any) => yaml.dump(value, { lineWidth: -1, noRefs: true }) } });
    components = await prepareHostComponents(bindingFor(host, true), profileDir, selectedNpm, mode);
    const summary = () => ({ state: repairs.every((repair: any) => repair.state === 'prepared') && !added.length ? 'prepared' : 'planned',
      id: preparationId, directory: root, materialSha256, selector: initial.selector, manager: { name: manager.name, version: manager.version },
      repairs: repairs.map((repair: any) => ({ name: repair.name, category: repair.category, state: repair.state,
        patchSha256: repair.sha256, ownership: record?.files.some(file => file.name === repair.name && file.owned) ? 'owned' : repair.state === 'prepared' ? 'borrowed' : 'planned-owned' })),
      packages: Object.fromEntries((record?.packages.filter(entry => entry.owned).map(entry => entry.name) ?? added).map(name => [name, material.supplements[name]])),
      ownerChanges: { dependencyKeys: initial.manager === 'npm' ? added : [],
        extensionKeys: initial.manager === 'pnpm' && added.length ? [`@deepseek-ai/dsh@${initial.version}/dependencies/${added.join(',')}`] : [],
        patchKeys: newPatches, lock: initial.selector.lockFile }, transaction: record?.phase ?? 'none',
      ...(record?.failure ? { failure: record.failure } : {}) });
    const save = () => persistSetupRecord(path.join(root, 'preparation.json'), record!);
    async function acquire() {
      if (preparationRelease) return;
      preparationRelease = await setupTransaction(root);
      if (JSON.stringify(inspectDshInstallation(initial.selector)) !== JSON.stringify(initial)) fail('PACKAGE_PLAN_STALE', 'The selected native owner changed after planning. Preserve its current files and retry the exact selection.');
      for (const [directory, expected] of Object.entries(affectedInventories)) if (canonicalSha256(packageInventory(directory)) !== canonicalSha256(expected)) fail('PACKAGE_PLAN_STALE', 'An affected package changed during confirmation. Its edits were preserved; no native operation ran.');
      const retained = preparationRecord(root, initial.selector, preparationId, initial.version, materialSha256);
      if (JSON.stringify(retained) !== JSON.stringify(record)) fail('PACKAGE_PLAN_STALE', 'This installation preparation changed in another operation. Review its latest durable phases and retry.');
    }
    async function apply() {
      await acquire();
      if (!record) {
        record = { schemaVersion: 1, kind: 'dsh-preparation', id: preparationId, root, selector: initial.selector, version: initial.version,
          materialSha256, manager, phase: 'intent', ownerKeys, createdContainers,
          lock: { beforeSha256: sha256(beforeLock), afterSha256: sha256(lockBytes), phase: 'pending' },
          files: repairs.flatMap((repair: any) => repair.files.map((file: any) => ({ name: repair.name, packageName: repair.packageName,
            file: file.file, beforeDirectory: repair.directory, beforeSha256: file.beforeSha256, afterSha256: file.afterSha256,
            owned: file.state === 'unprepared', phase: file.state === 'unprepared' ? 'pending' : 'borrowed' }))),
          patches: repairs.map((repair: any) => ({ selector: `${repair.packageName}@${repair.version}`, file: path.join(root, 'patches', repair.patch),
            sha256: repair.sha256, owned: true, phase: 'pending' })),
          packages: Object.entries(material.supplements).map(([name, version]) => ({ name, version: version as string, owned: added.includes(name) })),
          references: {}, beforeIdentity: initial.evidence, createdAt: new Date().toISOString() };
        save();
      }
      const completedPhase = unchanged && record.phase === 'configured' ? 'configured' : 'verified';
      try {
        for (const patch of record.patches) {
          const repair = repairs.find((entry: any) => `${entry.packageName}@${entry.version}` === patch.selector);
          if (!repair || patch.sha256 !== repair.sha256 || patch.file !== path.join(root, 'patches', repair.patch)) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'The retained patch ownership is ambiguous. Its files were preserved.');
          fs.mkdirSync(path.dirname(patch.file), { recursive: true, mode: 0o700 });
          if (!fs.existsSync(patch.file)) replaceOwnedFile(patch.file, fs.readFileSync(path.join(materialDirectory, initial.version, repair.patch)), 'missing');
          if (fileSha256(patch.file) !== patch.sha256) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'An owned patch material changed later. Preserve it and review its native declaration.');
          patch.phase = 'written'; save();
        }
        if (!['verified', 'configured'].includes(record.phase) || !unchanged) {
          record.phase = 'materials-written'; record.failure = undefined; save();
          assertConfigurationFile(manifestFile); assertConfigurationFile(lockFile);
          if (ownerKeys.length) replaceOwnedFile(manifestFile, JSON.stringify(plannedManifest, null, 2) + '\n', initial.evidence[manifestFile]);
          for (const key of record.ownerKeys) {
            if (canonicalSha256(atKey(json(manifestFile), key.path)) !== canonicalSha256(key.after)) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'An owned native declaration no longer matches its exact intent. Preserve it before recovery.');
            key.phase = 'applied'; save();
          }
          if (!unchanged) replaceOwnedFile(lockFile, lockBytes, sha256(beforeLock));
          record.lock.phase = 'applied'; record.phase = 'owner-prepared'; save();
          if (!unchanged) {
            record.phase = 'native-preparing'; save();
            const result = execute(manager.name === 'pnpm' ? ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace', '--prefer-offline']
              : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], initial.owner);
            if (result.status !== 0 || result.error) {
              record.failure = { code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'PACKAGE_TOOL_FAILED', phase: record.phase, exit: result.status, signal: result.signal }; save();
              fail('DSH_NATIVE_PREPARATION_FAILED', `The selected ${manager.name} preparation failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code}, signal ${result.signal ?? 'none'}). Completed owned phases remain at ${root}; native registration did not run. Preserve that record and retry the same selection after resolving the package-tool failure.`);
            }
          }
          record.phase = 'native-prepared'; record.failure = undefined; save();
        }
        const prepared = inspectDshInstallation(initial.selector);
        const preparedRequire = createRequire(path.join(prepared.directory, 'package.json'));
        for (const entry of record.files) {
          const identity = installedPackage(preparedRequire, entry.packageName, prepared.owner);
          if (!identity) fail('DSH_PACKAGE_MISMATCH', 'A repaired program package is missing after the native operation. Preserve its preparation record.');
          const file = path.join(identity.directory, entry.file);
          if (prepared.manager === 'npm' && entry.owned && fileSha256(file) === entry.beforeSha256) {
            const repair = repairs.find((repair: any) => repair.packageName === entry.packageName);
            const parsed = readExactPatch(fs.readFileSync(path.join(root, 'patches', repair.patch))).find(patch => patch.file === entry.file)!;
            const bytes = applyExactHunks(fs.readFileSync(file), parsed.hunks);
            if (sha256(bytes) !== entry.afterSha256) fail('DSH_MATERIAL_INVALID', 'The exact repair cannot produce its reviewed postimage. Registration did not run.');
            replaceOwnedFile(file, bytes, entry.beforeSha256);
          }
          if (fileSha256(file) !== entry.afterSha256) fail('DSH_CONTRACT_MISMATCH', 'A required repaired file differs after native preparation. Preserve the completed phases; registration did not run.');
          entry.directory = identity.directory; entry.phase = entry.owned ? 'applied' : 'borrowed'; save();
        }
        const verification = inspectDshHostPreparation(prepared.owner, { experimental, installation: prepared.selector });
        if (!verification.ready) fail(verification.reason, verification.guidance);
        for (const entry of record.packages) {
          const identity = installedPackage(preparedRequire, entry.name, prepared.owner);
          if (!identity || identity.version !== entry.version) fail('DSH_PACKAGE_MISMATCH', 'A browser supplement has a different installed identity. Native registration did not run.');
          const inventory = packageInventory(identity.directory), expected = material.packageInventories[`${entry.name}@${entry.version}`];
          if (canonicalSha256(inventory) !== canonicalSha256(expected)) fail('DSH_PROGRAM_CHANGE_CONFLICT', 'A browser supplement differs from its complete reviewed inventory. Preserve it; native registration did not run.');
          entry.directory = identity.directory; entry.inventory = inventory;
        }
        record.lock.afterSha256 = fileSha256(lockFile); record.afterIdentity = prepared.evidence; record.phase = completedPhase; record.failure = undefined; save();
        for (const repair of repairs) repair.state = 'prepared';
        added.length = 0;
        await components?.close();
        host = dshBorrowedModules(prepared, dshBorrowedNames);
        components = await prepareHostComponents(bindingFor(host, false), profileDir, selectedNpm);
        return verification;
      } catch (error) {
        if (!record.failure) { record.failure = { code: error instanceof SetupError ? error.code : error instanceof Error ? error.message : 'DSH_PREPARATION_FAILED', phase: record.phase, exit: null, signal: null }; save(); }
        throw error;
      }
    }
    function registration(phase: 'prepared' | 'configured') {
      if (!record || !['verified', 'configured'].includes(record.phase)) fail('DSH_PREPARATION_OWNERSHIP_CONFLICT', 'Verified preparation ownership is unavailable. Native registration cannot be recorded as complete.');
      record.references[profileDir] = { target: initial.selector.packageDirectory, phase };
      if (phase === 'configured') record.phase = 'configured';
      save();
    }
    return { get host() { return host; }, initial, material, materialSha256, root, preparationId, repairs,
      get components() { return components!; }, summary, acquire, apply, registration,
      close: async () => { await components?.close(); if (stage) fs.rmSync(stage, { recursive: true, force: true }); await preparationRelease?.(); } };
  } catch (error) {
    await components?.close(); if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (error instanceof SetupError) throw error;
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error && /^DSH_|^PACKAGE_/.test(error.message) ? error.message : 'DSH_PREPARATION_FAILED';
    const guidance = error instanceof Error && 'guidance' in error && typeof error.guidance === 'string' ? error.guidance : 'No success was recorded. Preserve the selected installation and inspect its exact preparation requirements.';
    return fail(code, guidance);
  }
}
