import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as jsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { inspectDshEnvironment } from './environment.mjs';
import { canonicalSha256, inspectDshDependencyClosure, inspectDshHostPreparation, inspectDshInstallation,
  dshBorrowedModules, inspectDshBoundCompositionDependencyClosure, inspectComponentResource, physicalPackage } from '@arlo/daemon/setup-dsh';

const baseline = JSON.parse(fs.readFileSync(new URL('./reviewed-composition.json', import.meta.url), 'utf8'));
const formalHostVersions = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'];
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Freeze load-bearing entry selectors, while allowing experimental version
// metadata to differ. Both import/require conditions and DSH client routes matter.
const entryFields = ['type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh'];
const routingSha = manifest => sha(JSON.stringify(Object.fromEntries(entryFields
  .filter(key => key in manifest).map(key => [key, manifest[key]]))));
/** The actual installed files, never a caller's version or capability declaration. */
export function inspectDshWebComposition(consumer, { experimental = false } = {}) {
  consumer = path.resolve(consumer);
  const require = createRequire(path.join(path.resolve(consumer), 'package.json'));
  let deployment, bound;
  try {
    deployment = readJson(path.join(consumer, 'package.json')).arlo?.dshInstallation;
    if (deployment) {
      bound = inspectDshInstallation(deployment.selector);
      // This is the user's explicit deployment choice saved at confirmation.
      // It changes admission policy only; every actual identity gate still runs.
      experimental ||= deployment.experimentalCompatibility === true;
    }
  } catch { /* a failed selected-installation check is added below */ }
  const hostPreparation = inspectDshHostPreparation(consumer, { experimental, ...(deployment ? { installation: deployment.selector } : {}) });
  const checks = [...hostPreparation.checks];
  const packages = { ...hostPreparation.packages };
  const contracts = { ...hostPreparation.contracts };
  const patches = { ...hostPreparation.patches };
  const frontend = hostPreparation.frontend;
  const lockSha256 = hostPreparation.lockSha256;
  let patchDeclarations;
  try { patchDeclarations = readJson(path.join(consumer, 'package.json')).pnpm?.patchedDependencies; } catch { /* recorded by host preparation */ }
  let dependencyClosure = null;
  let runtimeIdentityVerified = false;
  const check = (code, subject, operation) => {
    try { checks.push({ code, subject, ok: operation() === true }); }
    catch { checks.push({ code, subject, ok: false }); }
  };
  const hostVersion = hostPreparation.hostVersion;
  let hostRequire;
  try { hostRequire = createRequire(bound ? path.join(bound.directory, 'package.json') : require.resolve('@deepseek-ai/dsh/package.json')); } catch { /* recorded by host preparation */ }
  const candidateProfiles = { '0.2.1-rc.2': './candidate-composition.json', '0.2.1-rc.5': './rc5-composition.json' };
  const reviewed = Object.hasOwn(candidateProfiles, hostVersion)
    ? readJson(new URL(candidateProfiles[hostVersion], import.meta.url)) : baseline;
  if (deployment) check('DSH_INSTALLATION_IDENTITY_CONFLICT', 'durable-selected-host-binding', () => {
    if (!bound || typeof deployment.experimentalCompatibility !== 'boolean' || !reviewed.companion
      || deployment.materialSha256 !== hostPreparation.preparationMaterialSha256) return false;
    const resource = inspectComponentResource(consumer);
    const actual = dshBorrowedModules(bound, Object.keys(resource.borrowed));
    if (JSON.stringify(resource.host) !== JSON.stringify(actual) || JSON.stringify(resource.host.selector) !== JSON.stringify(deployment.selector)) return false;
    const adapterDirectory = path.dirname(require.resolve('@arlo/adapter-dsh'));
    const adapterManifest = readJson(path.join(adapterDirectory, 'package.json'));
    return Object.keys(adapterManifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/')).every(name =>
      resource.borrowed[name] && physicalPackage(adapterDirectory, name) === physicalPackage(bound.directory, name));
  });
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-session-persistence-jsonl']) {
    check('DSH_MODULE_IDENTITY_MISMATCH', name, () => {
      const adapterRequire = createRequire(require.resolve('@arlo/adapter-dsh'));
      return fs.realpathSync(adapterRequire.resolve(name)) === fs.realpathSync(hostRequire.resolve(name));
    });
  }
  if (reviewed.adapter) {
    check('DSH_ADAPTER_CONTRACT_MISMATCH', '@arlo/adapter-dsh/entry-routing', () => {
      const directory = path.dirname(require.resolve('@arlo/adapter-dsh'));
      return routingSha(readJson(path.join(directory, 'package.json'))) === reviewed.adapter.routingSha256;
    });
    for (const [file, digest] of Object.entries(reviewed.adapter.files)) {
      check('DSH_ADAPTER_CONTRACT_MISMATCH', `@arlo/adapter-dsh/${file}`, () => {
        const directory = path.dirname(require.resolve('@arlo/adapter-dsh'));
        const actual = sha(fs.readFileSync(path.join(directory, file)));
        contracts[`@arlo/adapter-dsh/${file}`] = actual;
        return actual === digest;
      });
    }
  }
  check('DSH_DEPENDENCY_IDENTITY_MISMATCH', 'complete-installed-dependency-closure', () => {
    const { manifestRouting, ...closure } = bound ? inspectDshBoundCompositionDependencyClosure(consumer, bound)
      : inspectDshDependencyClosure(consumer, hostRequire);
    dependencyClosure = closure;
    // Known frozen selectors/dependency declarations remain mandatory in an
    // experiment too. A coherently changed version uses an unlisted profile;
    // optional packages absent on this platform need no invented manifest.
    const expected = { ...reviewed.dependencyManifests, ...(bound ? reviewed.companion?.dependencyManifests : {}) };
    runtimeIdentityVerified = !!reviewed.dependencyManifests && Object.entries(manifestRouting).every(([id, digest]) =>
      !Object.hasOwn(expected, id) || expected[id] === digest);
    return runtimeIdentityVerified;
  });
  const reviewedClosure = dependencyClosure?.lockSha256 === reviewed.dependencyClosureSha256;
  if (dependencyClosure && !reviewedClosure && !experimental) {
    check('DSH_EXPERIMENTAL_REQUIRED', 'complete-dependency-profile', () => false);
  }
  const failures = checks.filter(check => !check.ok);
  const verified = Object.entries(reviewed.packages).every(([name, expected]) => packages[name] === expected.version);
  const ready = failures.length === 0;
  let adapterDirectory;
  try { adapterDirectory = path.dirname(require.resolve('@arlo/adapter-dsh')); } catch { adapterDirectory = undefined; }
  const environment = inspectDshEnvironment(adapterDirectory, {
    hostVersion: hostVersion ?? null, packages, contracts, patches, frontend: frontend ?? null, lockSha256, dependencyClosure,
    runtimeIdentityVerified, runtimeManifestProfileSha256: canonicalSha256(reviewed.dependencyManifests ?? {}),
  });
  return {
    schemaVersion: 1, mode: experimental ? 'experimental' : 'verified', hostVersion: hostVersion ?? null,
    status: failures.length ? 'rejected' : experimental ? 'experimental' : 'verified',
    ready, formallySupported: ready && verified && reviewedClosure && hostVersion === reviewed.hostVersion && !experimental,
    hostSupportPolicy: ready && verified && reviewedClosure && hostVersion === reviewed.hostVersion && formalHostVersions.includes(hostVersion)
      ? 'formal' : 'experimental-required',
    requiredContracts: { ready, reason: failures[0]?.code ?? 'SATISFIED', scope: 'installed-composition' },
    ...environment,
    combination: sha(JSON.stringify({ packages, contracts, frontend, patchDeclarations, patches, lockSha256 })),
    lockSha256,
    packages, contracts, patches, frontend: frontend ?? null, dependencyClosure, checks,
    reason: failures[0]?.code ?? (experimental ? 'DSH_EXPERIMENTAL_COMBINATION' : 'DSH_REVIEWED_COMBINATION'),
    guidance: failures[0]?.code === 'DSH_EXPERIMENTAL_REQUIRED'
      ? 'This exact DSH composition requires explicit experimental selection. Required contracts, module identity, patches and browser integrity remain mandatory.'
      : failures.length ? 'Use the reviewed private Web bundle. Port and validate missing contracts, patches and browser resources before retrying.'
      : experimental ? 'Experimental entry: required composition checks passed; this does not expand formal Web support.'
      : 'Reviewed DSH Web composition checks passed; native acceptance results remain separately recorded.',
  };
}

/** Stop before registering a communication endpoint when any required check fails. */
export function requireDshWebComposition(consumer, options) {
  const report = inspectDshWebComposition(consumer, options);
  if (!report.ready) {
    const error = new Error(`${report.reason}: ${report.guidance}`);
    error.code = report.reason;
    error.report = report;
    throw error;
  }
  return report;
}

/** Locate npm/pnpm's installation root from this installed adapter's real path. */
export function dshInstallationDirectory(entry) {
  const parts = fs.realpathSync(entry).split(path.sep);
  const index = parts.lastIndexOf('node_modules');
  const pnpm = parts.indexOf('.pnpm');
  const boundary = pnpm >= 0 ? pnpm - 1 : index;
  if (boundary < 0 || parts[boundary] !== 'node_modules') throw new Error('DSH_INSTALLATION_MISSING: Use a private installed Web bundle.');
  return parts.slice(0, boundary).join(path.sep) || path.parse(entry).root;
}

/** Validate the public live Host services as well as the installed composition. */
export function requireDshHostContracts(ctx, { experimental = false, hostVersion } = {}) {
  for (const [service, methods] of Object.entries({
    agents: ['get', 'roots', 'currentInitiator', 'requireInitiator'],
    sessions: ['get', 'list', 'flush'], tools: ['register'],
    sessionProjections: ['stateOf', 'snapshot'], sessionController: ['create'],
    agentDefaultModel: ['currentSelection'], workspaceRegistry: ['list'],
    llm: ['listProviders', 'listModels', 'resolveModelInfo'], typert: ['register'],
  })) {
    for (const method of methods) {
      if (typeof ctx[service]?.[method] !== 'function') {
        const error = new Error(`DSH_HOST_CONTRACT_MISSING: ${service}.${method}`);
        error.code = 'DSH_HOST_CONTRACT_MISSING';
        throw error;
      }
    }
  }
  if (experimental || ['0.2.1-rc.2', '0.2.1-rc.5'].includes(hostVersion)) {
    const persistence = typeof jsonlPersistence.ownershipOf === 'function'
      ? jsonlPersistence.ownershipOf(ctx.get('sessionPersistence')) : undefined;
    for (const method of ['resolveCurrentLog', 'hasPendingSession', 'open']) {
      if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence[method] !== 'function') {
        const error = new Error(`DSH_HOST_CONTRACT_MISSING: sessionPersistence.${method}`);
        error.code = 'DSH_HOST_CONTRACT_MISSING';
        throw error;
      }
    }
  }
}
