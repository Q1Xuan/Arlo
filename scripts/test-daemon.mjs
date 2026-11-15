import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { testRoot, createdTestRoot } from '../tests/permission-preload.mjs';

// Preload before test modules and their imports can change any permissions.
const args = process.argv.slice(2);
// Reporter/concurrency options alone must not expand discovery to web, probes
// or packaging drivers. Keep the same default file boundary as CI.
// Node 24 accepts both --option=value and --option value. A reporter module,
// name pattern or output path is an option value even when it ends in .js.
const valueOptions = new Set(`
  --test-concurrency --test-timeout --test-shard --test-name-pattern --test-skip-pattern
  --test-reporter --test-reporter-destination --test-rerun-failures --test-global-setup
  --test-coverage-branches --test-coverage-functions --test-coverage-lines
  --test-coverage-include --test-coverage-exclude --test-isolation --experimental-test-isolation
  --import --require -r --conditions -C --loader --experimental-loader
  --allow-fs-read --allow-fs-write --build-snapshot-config --cpu-prof-dir --cpu-prof-interval
  --cpu-prof-name --diagnostic-dir --disable-proto --disable-warning --dns-result-order
  --env-file --env-file-if-exists --eval -e --print -p --experimental-config-file
  --experimental-sea-config --heap-prof-dir --heap-prof-interval --heap-prof-name
  --heapsnapshot-near-heap-limit --heapsnapshot-signal --icu-data-dir --input-type
  --debug-port --inspect-port --inspect-publish-uid --localstorage-file --max-http-header-size
  --max-old-space-size-percentage --network-family-autoselection-attempt-timeout
  --openssl-config --redirect-warnings --report-directory --report-dir --report-filename
  --report-signal --run --secure-heap --secure-heap-min --snapshot-blob --title
  --tls-cipher-list --tls-keylog --trace-event-categories --trace-event-file-pattern
  --trace-require-module --unhandled-rejections --use-largepages --v8-pool-size
  --watch-kill-signal --watch-path
`.trim().split(/\s+/));
let hasTestPath = false;
let optionsEnded = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (!optionsEnded && arg === '--') { optionsEnded = true; continue; }
  if (!optionsEnded && arg.startsWith('-')) {
    if (valueOptions.has(arg)) {
      if (index + 1 === args.length) throw new Error(`Missing value for ${arg}`);
      index++;
    }
    continue;
  }
  hasTestPath = true;
}
const child = spawn(process.execPath, ['--test', ...args,
  ...(hasTestPath ? [] : ['tests/*.test.ts', 'tests/*.test.mjs'])],
  { stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` } });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  if (code === 0 && createdTestRoot && !fs.lstatSync(testRoot).isSymbolicLink() &&
      JSON.parse(fs.readFileSync(path.join(testRoot, '.arlo-test-owner.json'), 'utf8')).owner === process.env.ARLO_TEST_OWNER) {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else if (createdTestRoot) console.error(`Test resources retained: ${testRoot}`);
});
