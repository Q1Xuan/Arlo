import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { inspectPiInstallation, npmCli, type HostInstallation } from './components.ts';

export async function askSetup(question: string): Promise<string | undefined> {
  const prompt = createInterface({ input: stdin, output: stdout });
  prompt.on('SIGINT', () => prompt.close());
  stdout.write(question);
  try {
    for await (const line of prompt) return line.trim();
    return undefined;
  } finally { prompt.close(); }
}
const cancelled = (answer: string | undefined) => answer === undefined || ['', '0', 'q', 'cancel'].includes(answer.toLowerCase());

/** Resolve installed entries without executing arbitrary PATH launchers. */
export function locateInstalledHost(value: string, packageName: string, binName: string): string | undefined {
  try {
    const actual = fs.realpathSync(value);
    if (fs.statSync(actual).isDirectory()) return actual;
    let file = actual;
    // Known npm/pnpm generated shims use basedir/%~dp0%; accept only a
    // literal installed bin path, then verify it against its own manifest.
    if (!file.endsWith('.js')) {
      const text = fs.readFileSync(file, 'utf8');
      const packagePattern = packageName.split('/').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
      const literal = text.match(new RegExp(`(?:\\$basedir|%~dp0%)[\\\\/]([^"\\r\\n]*${packagePattern}[\\\\/][^"\\r\\n]*\\.js)`))?.[1];
      if (!literal) return;
      file = fs.realpathSync(path.resolve(path.dirname(file), literal.replaceAll('\\', path.sep)));
    }
    for (let directory = path.dirname(file); path.dirname(directory) !== directory; directory = path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === packageName && typeof pkg.bin?.[binName] === 'string' &&
        fs.realpathSync(path.join(directory, pkg.bin[binName])) === file) return directory;
    }
  } catch { /* Invalid entries are never candidates. */ }
}
export function locatePi(value: string): string | undefined {
  return locateInstalledHost(value, '@earendil-works/pi-coding-agent', 'pi');
}

export function discoverInstalledHosts<Host extends { directory: string }>(packageName: string, binName: string,
  inspect: (directory: string) => Host, selectedNpm?: string, retained: { value: string; provenance: string }[] = []) {
  const hints = [...retained];
  const add = (value: unknown, provenance: string) => { if (typeof value === 'string') hints.push({ value, provenance }); };
  try {
    const npm = npmCli(selectedNpm);
    const root = spawnSync(process.execPath, [npm, 'root', '-g'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (root.status === 0) add(path.join(root.stdout.trim(), packageName), 'npm global root');
    const list = spawnSync(process.execPath, [npm, 'ls', '-g', '--depth=0', '--json', '--long'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    try { add(JSON.parse(list.stdout).dependencies?.[packageName]?.path, 'npm global list'); } catch { /* absent global list */ }
  } catch { /* Discovery can still use PATH, local resolution and manual location. */ }
  const pathRoots = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const root of pathRoots) {
    for (const name of process.platform === 'win32' ? [binName, `${binName}.cmd`, `${binName}.ps1`, `${binName}.exe`] : [binName]) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) add(file, `PATH launcher ${file}`);
    }
  }
  const pnpm = pathRoots.map(root => path.join(root, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')).find(file => fs.existsSync(file));
  if (pnpm) {
    const script = fs.realpathSync(pnpm);
    // Known JavaScript CLIs are invoked through the current Node; generated
    // Windows cmd launchers are not executed via a shell during discovery.
    if (/\.(?:js|cjs)$/.test(script)) {
      const root = spawnSync(process.execPath, [script, 'root', '-g'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      if (root.status === 0) add(path.join(root.stdout.trim(), packageName), 'pnpm global root');
      const list = spawnSync(process.execPath, [script, 'list', '-g', '--depth=0', '--json'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      try { for (const project of JSON.parse(list.stdout)) add(project.dependencies?.[packageName]?.path, 'pnpm global list'); } catch { /* absent global list */ }
    }
  }
  for (const root of createRequire(path.join(process.cwd(), 'package.json')).resolve.paths(packageName) ?? []) {
    add(path.join(root, packageName), 'caller local Node resolution');
  }
  const candidates = new Map<string, Host & { provenance: string[] }>();
  let rejected = 0;
  for (const hint of hints) {
    if (!fs.existsSync(hint.value)) continue;
    try {
      const directory = locateInstalledHost(hint.value, packageName, binName);
      if (!directory) { rejected++; continue; }
      const host = inspect(directory);
      const existing = candidates.get(host.directory);
      if (existing) { if (!existing.provenance.includes(hint.provenance)) existing.provenance.push(hint.provenance); }
      else candidates.set(host.directory, { ...host, provenance: [hint.provenance] });
    } catch { rejected++; }
  }
  return { candidates: [...candidates.values()].sort((a, b) => a.directory.localeCompare(b.directory)), rejected };
}

export function discoverPi(agentDir: string, selectedNpm?: string): { candidates: (HostInstallation & { provenance: string[] })[]; rejected: number } {
  const retained: { value: string; provenance: string }[] = [];
  try {
    const target = JSON.parse(fs.readFileSync(path.join(agentDir, 'arlo-setup/pi.json'), 'utf8')).target;
    if (typeof target === 'string') retained.push({ value: target, provenance: 'selected user setup record (revalidated)' });
  } catch { /* no valid hint */ }
  return discoverInstalledHosts('@earendil-works/pi-coding-agent', 'pi', inspectPiInstallation, selectedNpm, retained);
}

export async function selectPi(agentDir: string, npm?: string): Promise<string | undefined> {
  const { candidates, rejected } = discoverPi(agentDir, npm);
  if (candidates.length) {
    stdout.write(`Existing Pi installations (user agent directory: ${agentDir})\n`);
    candidates.forEach((host, index) => stdout.write(`  ${index + 1}. @earendil-works/pi-coding-agent ${host.version}\n     Package: ${host.directory}\n     Bin: ${host.bin}\n     Owner: ${host.owner} (${host.manager}${host.managerVersion ? `@${host.managerVersion}` : ''})\n     Found via: ${host.provenance.join('; ')}\n`));
    if (rejected) stdout.write(`${rejected} unverifiable entry/entries were excluded. Use manual location to review an installation.\n`);
    while (true) {
      const answer = await askSetup('Choose installed Pi [number, m for manual location, 0 to cancel]: ');
      if (cancelled(answer)) return;
      if (answer?.toLowerCase() === 'm') break;
      if (answer && /^\d+$/.test(answer) && candidates[Number(answer) - 1]) return candidates[Number(answer) - 1].directory;
    }
  } else stdout.write('No verified Pi installation was found in standard npm/pnpm information, PATH or caller resolution. Locate your existing package directory or its pi bin. Setup never downloads another host.\n');
  const answer = await askSetup('Exact installed host package directory or Pi bin (0 to cancel): ');
  if (cancelled(answer)) return;
  return locatePi(answer!) ?? answer;
}
