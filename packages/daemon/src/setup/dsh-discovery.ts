import fs from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { inspectDshInstallation } from '../../setup-dsh/installed-host.mjs';
import { askSetup, discoverInstalledHosts, locateInstalledHost } from './pi-discovery.ts';
import { assertConfigurationFile } from './transaction.ts';

const cancelled = (answer: string | undefined) => answer === undefined || ['', '0', 'q', 'cancel'].includes(answer.toLowerCase());

function profiles(home: string): { name: string; directory: string }[] {
  try {
    const root = path.join(fs.realpathSync(home), 'profiles');
    if (fs.lstatSync(root).isSymbolicLink()) return [];
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) return [];
      const directory = path.join(root, entry.name);
      try {
        const file = path.join(directory, 'package.json');
        assertConfigurationFile(file);
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
        return [{ name: entry.name, directory }];
      } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

export async function selectDsh(home: string, npm?: string): Promise<string | undefined> {
  const retained: { value: string; provenance: string }[] = [];
  for (const profile of profiles(home)) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(profile.directory, 'arlo-setup/dsh.json'), 'utf8'));
      if (typeof record.target === 'string') retained.push({ value: record.target, provenance: `selected profile ${profile.name} setup record (revalidated)` });
    } catch { /* a missing or invalid record is not a selection */ }
  }
  const { candidates, rejected } = discoverInstalledHosts('@deepseek-ai/dsh', 'dsh', inspectDshInstallation, npm, retained);
  if (candidates.length) {
    stdout.write('Existing DSH installations\n');
    candidates.forEach((host, index) => stdout.write(`  ${index + 1}. @deepseek-ai/dsh ${host.version}\n     Package: ${host.directory}\n     Native package route: ${host.selector.packageDirectory}\n     Bin: ${host.bin}\n     Owner: ${host.owner} (${host.manager}${host.managerVersion ? `@${host.managerVersion}` : ''})\n     Found via: ${host.provenance.join('; ')}\n`));
    if (rejected) stdout.write(`${rejected} unverifiable installation entry/entries were excluded. Use manual location to review their actual owner.\n`);
    while (true) {
      const answer = await askSetup('Choose installed DSH [number, m for manual location, 0 to cancel]: ');
      if (cancelled(answer)) return;
      if (answer?.toLowerCase() === 'm') break;
      if (answer && /^\d+$/.test(answer) && candidates[Number(answer) - 1]) return candidates[Number(answer) - 1].selector.packageDirectory;
    }
  } else stdout.write('No verified DSH installation was found in standard npm/pnpm information, PATH or caller resolution. Locate the original installed package directory or dsh bin.\n');
  const answer = await askSetup('Exact installed DSH package directory or native dsh bin (0 to cancel): ');
  if (cancelled(answer)) return;
  return locateInstalledHost(answer!, '@deepseek-ai/dsh', 'dsh') ?? answer;
}

export async function selectDshProfile(selectedHome: string): Promise<{ home: string; profile: string } | undefined> {
  let home = selectedHome;
  while (true) {
    const candidates = profiles(home);
    if (candidates.length) {
      home = fs.realpathSync(home);
      stdout.write(`Existing DSH profiles (home: ${home})\n`);
      candidates.forEach((profile, index) => stdout.write(`  ${index + 1}. ${profile.name}\n     Directory: ${profile.directory}\n`));
      const answer = await askSetup('Choose existing DSH profile [number, m for another existing home, 0 to cancel]: ');
      if (cancelled(answer)) return;
      if (answer?.toLowerCase() !== 'm') {
        if (answer && /^\d+$/.test(answer) && candidates[Number(answer) - 1]) return { home, profile: candidates[Number(answer) - 1].name };
        continue;
      }
    } else stdout.write(`No readable existing DSH profile was found under ${home}. Select its existing owning home; setup does not create a profile.\n`);
    const answer = await askSetup('Existing DSH home directory (0 to cancel): ');
    if (cancelled(answer)) return;
    home = path.resolve(answer!);
  }
}
