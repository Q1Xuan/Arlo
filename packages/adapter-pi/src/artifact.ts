import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Bind evidence metadata to the installed adapter without hashing the metadata itself. */
export function piAdapterArtifactSha256(directory: string): string {
  const hash = createHash('sha256');
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
        hash.update(file).update('\0').update(fs.readFileSync(path.join(directory, file))).update('\0');
      }
    }
  };
  visit('src');
  return hash.digest('hex');
}
