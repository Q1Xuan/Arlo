import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './errors.ts';

export type ConsumerInventory = Record<string, { kind: 'file'; sha256: string; semanticSha256?: string } | { kind: 'directory' } | { kind: 'link'; target: string }>;
export type InventoryYaml = { parse(source: string): any };

/** Records owned entries without following borrowed peer or package links. */
export function consumerInventory(directory: string, yaml?: InventoryYaml): ConsumerInventory {
  if (fs.lstatSync(directory).isSymbolicLink()) fail('COMPONENT_OWNERSHIP_CONFLICT', 'The component consumer was redirected. Preserve its current target for review.');
  const entries: [string, ConsumerInventory[string]][] = [];
  function visit(relative: string) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      const location = path.join(directory, file);
      if (entry.isDirectory()) { entries.push([file, { kind: 'directory' }]); visit(file); }
      else if (entry.isSymbolicLink()) entries.push([file, { kind: 'link', target: fs.readlinkSync(location) }]);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(location);
        const owned: ConsumerInventory[string] = { kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex') };
        if (yaml && file === path.join('node_modules', '.modules.yaml')) {
          const modules = yaml.parse(bytes.toString('utf8'));
          delete modules.prunedAt;
          function normalize(value: any): any {
            if (typeof value === 'string') return value === directory || value.startsWith(directory + path.sep) ? '$consumer' + value.slice(directory.length) : value;
            if (Array.isArray(value)) return value.map(normalize);
            if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
            return value;
          }
          owned.semanticSha256 = createHash('sha256').update(JSON.stringify(normalize(modules))).digest('hex');
        }
        entries.push([file, owned]);
      }
      else fail('COMPONENT_OWNERSHIP_CONFLICT', 'An unexpected entry appeared in the component consumer. Preserve it for review.');
    }
  }
  visit('');
  return Object.fromEntries(entries);
}

export function validConsumerInventory(value: ConsumerInventory | undefined): value is ConsumerInventory {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([file, entry]) =>
    file !== '' && !path.isAbsolute(file) && path.normalize(file) === file && !file.split(path.sep).includes('..') && !file.includes('\0') && entry &&
    (entry.kind === 'directory' || entry.kind === 'file' && /^[a-f0-9]{64}$/.test(entry.sha256)
      && (entry.semanticSha256 === undefined || file === path.join('node_modules', '.modules.yaml') && /^[a-f0-9]{64}$/.test(entry.semanticSha256))
      || entry.kind === 'link' && typeof entry.target === 'string' && !entry.target.includes('\0')));
}

/** An interrupted standard removal may delete entries and apply its exact
 * projected metadata. Added or edited entries are never deletion authority. */
export function matchesOwnedProgress(current: ConsumerInventory, before: ConsumerInventory | undefined, after?: ConsumerInventory): boolean {
  if (!validConsumerInventory(before) || after !== undefined && !validConsumerInventory(after)) return false;
  const matches = (file: string, entry: ConsumerInventory[string], expected: ConsumerInventory[string] | undefined) =>
    JSON.stringify(entry) === JSON.stringify(expected) || file === path.join('node_modules', '.modules.yaml') && entry.kind === 'file'
      && expected?.kind === 'file' && entry.semanticSha256 !== undefined && entry.semanticSha256 === expected.semanticSha256;
  return Object.entries(current).every(([file, entry]) => matches(file, entry, before[file]) || after !== undefined && matches(file, entry, after[file]));
}
