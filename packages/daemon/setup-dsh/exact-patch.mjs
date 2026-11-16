import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileSha256 = file => fs.existsSync(file) ? sha256(fs.readFileSync(file)) : 'missing';

/** The bundled recipes modify existing files only. No shell patch program,
 * offset guessing, fuzz, path traversal or writes through hardlinks. */
export function readExactPatch(bytes) {
  const lines = bytes.toString().split('\n');
  const files = [];
  let file;
  for (let index = 0; index < lines.length;) {
    const line = lines[index++];
    if (line.startsWith('--- a/')) {
      const name = line.slice(6);
      if (lines[index++] !== `+++ b/${name}` || path.posix.isAbsolute(name) || name.split('/').includes('..') || name.includes('\\')) {
        throw new Error('DSH_MATERIAL_INVALID');
      }
      file = { file: name, hunks: [] };
      files.push(file);
    } else if (line.startsWith('@@ ')) {
      const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!file || !header) throw new Error('DSH_MATERIAL_INVALID');
      const hunk = { before: [], after: [], beforeNoNewline: false, afterNoNewline: false };
      let last;
      while (index < lines.length && !lines[index].startsWith('@@ ') && !lines[index].startsWith('--- a/')) {
        const payload = lines[index];
        if (payload === '' && index === lines.length - 1) { index++; break; }
        index++;
        if (payload === '\\ No newline at end of file') {
          if (!last || ![' ', '-', '+'].includes(last)) throw new Error('DSH_MATERIAL_INVALID');
          if (last !== '+') hunk.beforeNoNewline = true;
          if (last !== '-') hunk.afterNoNewline = true;
          continue;
        }
        last = payload[0];
        if (![' ', '-', '+'].includes(last)) throw new Error('DSH_MATERIAL_INVALID');
        if (last !== '+') hunk.before.push(payload.slice(1));
        if (last !== '-') hunk.after.push(payload.slice(1));
      }
      if (hunk.before.length !== Number(header[2] ?? 1) || hunk.after.length !== Number(header[4] ?? 1)) throw new Error('DSH_MATERIAL_INVALID');
      file.hunks.push(hunk);
    } else if (line && !line.startsWith('diff ') && !line.startsWith('index ')) throw new Error('DSH_MATERIAL_INVALID');
  }
  if (!files.length || files.some(file => !file.hunks.length)) throw new Error('DSH_MATERIAL_INVALID');
  return files;
}

/** Also provides the surgical inverse for owned cleanup; unrelated current
 * bytes remain in place, and ambiguous/edited owned contexts fail closed. */
export function applyExactHunks(bytes, hunks, inverse = false) {
  let source = bytes.toString();
  for (const hunk of inverse ? [...hunks].reverse() : hunks) {
    const oldLines = inverse ? hunk.after : hunk.before;
    const newLines = inverse ? hunk.before : hunk.after;
    const oldNoNewline = inverse ? hunk.afterNoNewline : hunk.beforeNoNewline;
    const newNoNewline = inverse ? hunk.beforeNoNewline : hunk.afterNoNewline;
    const before = oldLines.join('\n') + (oldNoNewline ? '' : '\n');
    const after = newLines.join('\n') + (newNoNewline ? '' : '\n');
    const matches = [];
    for (let start = source.indexOf(before); start >= 0; start = source.indexOf(before, start + 1)) {
      if ((start === 0 || source[start - 1] === '\n') && (!oldNoNewline || start + before.length === source.length)) matches.push(start);
    }
    if (matches.length !== 1) throw new Error('DSH_PROGRAM_CHANGE_CONFLICT');
    const start = matches[0];
    source = source.slice(0, start) + after + source.slice(start + before.length);
  }
  return Buffer.from(source);
}

export function packageInventory(directory) {
  const files = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files[name] = fileSha256(path.join(directory, name));
      else throw new Error('DSH_PROGRAM_CHANGE_CONFLICT');
    }
  }
  visit('');
  return files;
}

export function replaceOwnedFile(file, bytes, expected) {
  if (fileSha256(file) !== expected || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('PACKAGE_PLAN_STALE');
  const temporary = `${file}.arlo-${randomUUID()}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(temporary, bytes, { mode, flag: 'wx' });
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (fileSha256(file) !== expected) throw new Error('PACKAGE_PLAN_STALE');
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
