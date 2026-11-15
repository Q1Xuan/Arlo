import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { inspectDshWebComposition } from './compatibility.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const { values: { consumer, output, experimental = false } } = parseArgs({ args, options: {
  consumer: { type: 'string' }, output: { type: 'string' }, experimental: { type: 'boolean' },
} });
assert.ok(command === 'diagnose' && consumer,
  'Usage: dsh-compatibility.mjs diagnose --consumer DIR [--experimental] [--output FILE]');
const report = { ...inspectDshWebComposition(consumer, { experimental }),
  observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version };
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
