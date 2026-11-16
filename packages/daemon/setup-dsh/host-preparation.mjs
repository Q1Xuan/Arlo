import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { inspectDshHostDependencyClosure, inspectDshBoundHostDependencyClosure } from './dependency-closure.mjs';
import { inspectDshInstallation } from './installed-host.mjs';

const reviewedHosts = JSON.parse(fs.readFileSync(new URL('./reviewed-hosts.json', import.meta.url), 'utf8'));
const baseline = reviewedHosts['0.2.0-rc.2'];
const formalHostVersions = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'];
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// Freeze load-bearing entry selectors, while allowing experimental version
// metadata to differ. Both import/require conditions and DSH client routes matter.
const entryFields = ['type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh'];
const routingSha = manifest => sha(JSON.stringify(Object.fromEntries(entryFields
  .filter(key => key in manifest).map(key => [key, manifest[key]]))));
const resourceFiles = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    if (entry.isDirectory()) return resourceFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`);
    if (!entry.isFile()) throw new Error('Unexpected browser resource entry');
    return [`${prefix}${entry.name}`];
  }).sort();

/** The actual installed files, never a caller's version or capability declaration. */
export function inspectDshHostPreparation(consumer, { experimental = false, installation } = {}) {
  consumer = path.resolve(consumer);
  let bound;
  try { if (installation) bound = inspectDshInstallation(installation); } catch { /* bounded failed check below */ }
  const require = createRequire(path.join(bound?.owner ?? consumer, 'package.json'));
  const checks = [];
  const packages = {};
  const contracts = {};
  const patches = {};
  let patchDeclarations;
  let lockSha256 = null;
  let dependencyClosure = null;
  let runtimeIdentityVerified = false;
  const check = (code, subject, operation) => {
    try {
      const ok = operation();
      checks.push({ code, subject, ok: ok === true });
    } catch {
      checks.push({ code, subject, ok: false });
    }
  };
  let hostRequire;
  let hostVersion;
  let reviewed = baseline;
  check('DSH_LOCK_MISSING', 'independent-consumer-lock', () => {
    if (installation && !bound) return false;
    const lock = fs.readFileSync(path.join(bound?.owner ?? consumer, bound?.selector.lockFile ?? 'pnpm-lock.yaml'));
    lockSha256 = sha(lock);
    if (bound) return true; // Its native lock/importer and physical route were inspected above.
    const importers = lock.toString('utf8').match(/^importers:\r?\n([\s\S]*?)(?=^\S)/m)?.[1];
    return importers !== undefined && [...importers.matchAll(/^  (\S[^\r\n]*):\r?$/gm)]
      .map(match => match[1]).join(',') === '.';
  });
  check('DSH_HOST_MISSING', '@deepseek-ai/dsh', () => {
    const manifest = bound ? path.join(bound.directory, 'package.json') : require.resolve('@deepseek-ai/dsh/package.json');
    hostRequire = createRequire(manifest);
    hostVersion = readJson(manifest).version;
    return typeof hostVersion === 'string';
  });
  if (Object.hasOwn(reviewedHosts, hostVersion)) reviewed = reviewedHosts[hostVersion];
  let preparationMaterialSha256;
  if (bound) check('DSH_MATERIAL_INVALID', 'exact-native-preparation-material', () => {
    const bytes = fs.readFileSync(new URL(`./preparation-material/${hostVersion}/material.json`, import.meta.url));
    const material = JSON.parse(bytes);
    preparationMaterialSha256 = sha(bytes);
    return material.schemaVersion === 1 && material.hostVersion === hostVersion
      && material.repairs.length === Object.keys(reviewed.patches).length
      && material.repairs.every(repair => reviewed.patches[repair.patch] === repair.sha256);
  });
  for (const [name, file, signature] of [
    ['dsh-api-session-controller', 'lib/types/types.d.ts', 'interface SessionCreateOptions'],
    ['dsh-client-ui-conversation', 'lib/types/client/service.d.ts', 'registerSubmitPreparation('],
    ...(reviewed === baseline
      ? [['dsh-client-ui-primitives', 'lib/types/user-text.d.ts', 'projectUserText']]
      : [['dsh-client-ui-conversation', 'lib/types/client/conversation/user-text-registry.d.ts', 'register(rule: UserTextRule)'],
        ['dsh-session-persistence-jsonl', 'lib/types/index.d.ts', 'function ownershipOf(']]),
  ]) {
    check('DSH_REQUIRED_CONTRACT_MISSING', `${name}/${signature}`, () => {
      const directory = path.dirname(hostRequire.resolve(`@deepseek-ai/${name}/package.json`));
      return fs.readFileSync(path.join(directory, file), 'utf8').includes(signature);
    });
  }
  for (const [name, expected] of Object.entries(reviewed.packages)) {
    check('DSH_PACKAGE_MISMATCH', name, () => {
      const manifest = hostRequire.resolve(`${name}/package.json`);
      const installed = readJson(manifest);
      packages[name] = installed.version;
      // An experiment may change a coherent DSH release. Required reviewed
      // contract bytes and resources below still cannot be waived.
      return installed.version === expected.version;
    });
    check('DSH_ENTRY_MISMATCH', `${name}/entry-routing`, () => {
      const digest = routingSha(readJson(hostRequire.resolve(`${name}/package.json`)));
      contracts[`${name}/entry-routing`] = digest;
      return digest === expected.routingSha256;
    });
    for (const [file, digest] of Object.entries(expected.files)) {
      check(experimental && hostVersion !== reviewed.hostVersion ? 'DSH_CONTRACT_UNVERIFIED' : 'DSH_CONTRACT_MISMATCH', `${name}/${file}`, () => {
        const actual = sha(fs.readFileSync(path.join(path.dirname(hostRequire.resolve(`${name}/package.json`)), file)));
        contracts[`${name}/${file}`] = actual;
        return actual === digest;
      });
    }
  }
  check('DSH_PATCH_MISMATCH', 'complete-patch-set', () => {
    patchDeclarations = readJson(path.join(bound?.owner ?? consumer, 'package.json')).pnpm?.patchedDependencies;
    if (bound?.manager === 'npm') return fs.existsSync(new URL(`./preparation-material/${hostVersion}/material.json`, import.meta.url));
    return patchDeclarations && (bound ? Object.keys(patchDeclarations).length >= Object.keys(reviewed.patches).length
      : Object.keys(patchDeclarations).length === Object.keys(reviewed.patches).length);
  });
  for (const [name, digest] of Object.entries(reviewed.patches)) {
    check('DSH_PATCH_MISMATCH', name, () => {
      if (bound?.manager === 'npm') {
        // npm has no native patch declaration. Its surgical preparation uses
        // these same bundled exact recipes; reviewed actual postimages above
        // remain mandatory and are never inferred from a user record.
        const actual = sha(fs.readFileSync(new URL(`./preparation-material/${hostVersion}/${name}`, import.meta.url)));
        patches[name] = actual;
        return actual === digest;
      }
      const manifest = readJson(path.join(bound?.owner ?? consumer, 'package.json'));
      const declared = manifest.pnpm?.patchedDependencies?.[`@deepseek-ai/${name.slice(0, -6)}`];
      if (typeof declared !== 'string') return false;
      const actual = sha(fs.readFileSync(path.resolve(bound?.owner ?? consumer, declared)));
      patches[name] = actual;
      return actual === digest;
    });
  }
  let frontend;
  check('DSH_RESOURCE_MISMATCH', 'complete-embedded-browser-resources', () => {
    const directory = path.join(path.dirname(hostRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist');
    const files = Object.fromEntries(resourceFiles(directory).map(file => [file, sha(fs.readFileSync(path.join(directory, file)))]));
    frontend = { files, resourceSha256: sha(JSON.stringify(files)) };
    return JSON.stringify(files) === JSON.stringify(reviewed.frontend.files);
  });
  check('DSH_RESOURCE_MISMATCH', 'embedded-browser-resource', () => {
    const directory = path.dirname(hostRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json'));
    const html = fs.readFileSync(path.join(directory, 'dist/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
    const asset = scripts.map(script => script.replace(/^\.\//, '/'))
      .find(script => script.startsWith('/assets/index-') && script.endsWith('.js'));
    if (asset !== reviewed.frontend.asset) return false;
    const file = path.join(directory, 'dist', asset.slice(1));
    const digest = sha(fs.readFileSync(file));
    frontend = { ...frontend, asset, sha256: digest };
    return digest === reviewed.frontend.sha256;
  });
  if (!formalHostVersions.includes(hostVersion) && !experimental) {
    check('DSH_EXPERIMENTAL_REQUIRED', 'host-support-policy', () => false);
  }
  check('DSH_DEPENDENCY_IDENTITY_MISMATCH', 'complete-installed-host-dependency-closure', () => {
    const inspected = bound ? inspectDshBoundHostDependencyClosure(bound) : inspectDshHostDependencyClosure(consumer, hostRequire);
    const { manifestRouting, installedDirectories, ...closure } = inspected;
    dependencyClosure = closure;
    // Known frozen selectors/dependency declarations remain mandatory in an
    // experiment too. A coherently changed version uses an unlisted profile;
    // optional packages absent on this platform need no invented manifest.
    runtimeIdentityVerified = !!reviewed.dependencyManifests && Object.entries(manifestRouting).every(([id, digest]) =>
      !Object.hasOwn(reviewed.dependencyManifests, id) || reviewed.dependencyManifests[id] === digest);
    return runtimeIdentityVerified;
  });
  const reviewedClosure = dependencyClosure?.lockSha256 === reviewed.hostDependencyClosureSha256;
  if (dependencyClosure && !reviewedClosure && !experimental) {
    check('DSH_EXPERIMENTAL_REQUIRED', 'complete-dependency-profile', () => false);
  }
  const failures = checks.filter(check => !check.ok);
  const verified = Object.entries(reviewed.packages).every(([name, expected]) => packages[name] === expected.version);
  const ready = failures.length === 0;
  return {
    schemaVersion: 1, mode: experimental ? 'experimental' : 'verified', hostVersion: hostVersion ?? null,
    status: failures.length ? 'rejected' : experimental ? 'experimental' : 'verified',
    ready, formallySupported: ready && verified && reviewedClosure && hostVersion === reviewed.hostVersion && !experimental,
    hostSupportPolicy: ready && verified && reviewedClosure && hostVersion === reviewed.hostVersion && formalHostVersions.includes(hostVersion)
      ? 'formal' : 'experimental-required',
    requiredContracts: { ready, reason: failures[0]?.code ?? 'SATISFIED', scope: 'host-preparation' },
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    runtimeIdentityVerified,
    combination: sha(JSON.stringify({ packages, contracts, frontend, patchDeclarations, patches, lockSha256 })),
    lockSha256,
    ...(preparationMaterialSha256 ? { preparationMaterialSha256 } : {}),
    ...(bound ? { selectedInstallation: bound } : {}),
    packages, contracts, patches, frontend: frontend ?? null, dependencyClosure, checks,
    reason: failures[0]?.code ?? (experimental ? 'DSH_EXPERIMENTAL_COMBINATION' : 'DSH_REVIEWED_COMBINATION'),
    guidance: failures[0]?.code === 'DSH_EXPERIMENTAL_REQUIRED'
      ? 'This exact DSH composition requires explicit experimental selection. Required contracts, module identity, patches and browser integrity remain mandatory.'
      : failures.length ? 'Prepare the selected host using docs/INSTALL_ACCESS.md and the reviewed private DSH composition; required locks, package identities, patches and browser resources must exist before Arlo setup. Setup does not patch the host.'
      : experimental ? 'Experimental entry: required composition checks passed; this does not expand formal Web support.'
      : 'Reviewed DSH host preparation passed. Arlo package installation, profile registration and live communication remain separate checks.',
  };
}
