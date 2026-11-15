import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const repo = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const command = args.shift();
if (command === 'validate') {
  const { validate } = await import('../acceptance/compatibility.mjs');
  await validate(args);
} else if (command === 'matrix') {
  const { values } = parseArgs({ args, options: Object.fromEntries(
    ['host', 'version', 'platform', 'arch', 'node'].map(name => [name, { type: 'string' }]),
  ) });
  if (values.host && !['pi', 'dsh'].includes(values.host)) throw new Error('--host must be pi or dsh');
  const matrix = JSON.parse(fs.readFileSync(path.join(repo, 'docs/compatibility/support-matrix.json'), 'utf8'));
  const rows = matrix.rows.filter(row => Object.entries(values).every(([key, value]) => row[key] === value));
  if (!rows.length) rows.push({ ...values, support: 'untested', diagnosis: 'not-run', acceptance: 'not-run',
    testedCapabilities: [], limitations: [matrix.unknown], evidence: [] });
  console.log(JSON.stringify({ ...matrix, rows }, null, 2));
} else throw new Error('Usage: compatibility.mjs matrix|validate (see README.md)');
