#!/usr/bin/env node
import { runCli } from '../src/cli/index.ts';

runCli().then((code) => {
  if (code !== 0) {
    process.exit(code);
  }
}).catch(() => {
  console.error(JSON.stringify({ error: 'CORRUPTED_STATE' }));
  process.exit(1);
});
