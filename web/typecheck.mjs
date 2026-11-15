import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = fileURLToPath(new URL('../', import.meta.url));
const consumer = path.resolve(process.argv[2] ?? path.join(repo, '.artifacts/issue36-web/consumer'));
const installationRequire = createRequire(path.join(consumer, 'package.json'));
const hostManifest = installationRequire.resolve('@deepseek-ai/dsh/package.json');
const hostRequire = createRequire(hostManifest);
const contactDirectory = path.dirname(fs.realpathSync(installationRequire.resolve('@arlo/adapter-dsh')));
const contactRelative = path.relative(path.join(consumer, 'node_modules'), contactDirectory);
assert.ok(contactRelative && !contactRelative.startsWith('..') && !path.isAbsolute(contactRelative),
  'Contact declarations and source must come from the private installation');
assert.ok(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'].includes(JSON.parse(fs.readFileSync(hostManifest, 'utf8')).version),
  'Use a reviewed DSH installation profile');

// Resolve each public declaration from the installed package exports. This lets
// pnpm keep transitive Host packages nested without adding repository dependencies.
const imports = [
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session/types', '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway/client', '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-input-trigger/client', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-modules/client', '@arlo/adapter-dsh/runtime', '@arlo/sdk',
  '@deepseek-ai/dsh-client-ui-conversation/client', '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-llm',
];
const paths = {};
const versions = {};
for (const specifier of imports) {
  const segments = specifier.split('/');
  const packageName = segments.slice(0, 2).join('/');
  const subpath = segments.length === 2 ? '.' : `./${segments.slice(2).join('/')}`;
  let manifestFile;
  try { manifestFile = installationRequire.resolve(`${packageName}/package.json`); }
  catch {
    if (packageName.startsWith('@arlo/')) {
      manifestFile = path.join(consumer, 'node_modules', packageName, 'package.json');
    } else manifestFile = hostRequire.resolve(`${packageName}/package.json`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  versions[packageName] = manifest.version;
  const entry = manifest.exports?.[subpath];
  let declaration = typeof entry === 'object' ? entry.types : undefined;
  if (!declaration && subpath === '.') declaration = manifest.types;
  if (!declaration && packageName.startsWith('@arlo/')) {
    const runtime = typeof entry === 'string' ? entry : entry?.default;
    declaration = runtime?.replace(/\.js$/, '.d.ts');
  }
  assert.ok(declaration, `No published type declaration for ${specifier}`);
  const target = path.resolve(path.dirname(manifestFile), declaration);
  assert.ok(fs.existsSync(target), `Missing installed declaration: ${target}`);
  paths[specifier] = [target];
}

const formatHost = {
  getCanonicalFileName: name => name,
  getCurrentDirectory: () => repo,
  getNewLine: () => '\n',
};
for (const face of ['host', 'client']) {
  const configPath = path.join(contactDirectory, `tsconfig.${face}.json`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.ok(!config.error, `Cannot read ${configPath}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), {
    baseUrl: consumer, paths,
    typeRoots: [path.join(consumer, 'node_modules/@types')],
  });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
    process.exit(1);
  }
  console.log(`Installed DSH contact ${face}: strict checkJs passed against installed npm declarations`);
}
const publicProgram = ts.createProgram([path.join(consumer, 'web/public-api.mts')], {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
  strict: true, noEmit: true, skipLibCheck: false,
});
const publicDiagnostics = ts.getPreEmitDiagnostics(publicProgram);
if (publicDiagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(publicDiagnostics, formatHost));
  process.exit(1);
}
console.log('Installed adapter public exports: strict declarations passed without paths or skipLibCheck');
console.log(JSON.stringify({ typescript: ts.version, versions }, null, 2));
