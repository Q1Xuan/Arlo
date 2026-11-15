import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// A fresh process with the selected PowerShell tool unavailable exercises the
// OS boundary. It does not override production observation or OS metadata.
const [host, location] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
let report;
if (host === 'pi') {
  const installation = JSON.parse(fs.readFileSync(location, 'utf8'));
  const adapter = await import(pathToFileURL(installation.entries.adapterEntry).href);
  const methods = names => Object.fromEntries(names.map(name => [name, () => {}]));
  const header = { type: 'session', id: 'unavailable-observation', cwd: process.cwd() };
  const pi = methods(['sendMessage', 'sendUserMessage', 'appendEntry']);
  const ctx = { mode: 'tui', isIdle: () => true, abort() {},
    ui: methods(['notify', 'setStatus', 'setEditorComponent', 'getEditorComponent',
      'addAutocompleteProvider', 'onTerminalInput', 'select']),
    sessionManager: { getHeader: () => header, getSessionId: () => header.id,
      getSessionFile: () => path.resolve('diagnostic-session.jsonl'), getCwd: () => header.cwd,
      getEntries: () => [], getSessionName: () => 'unavailable-observation' } };
  report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
} else {
  assert.equal(host, 'dsh');
  const require = createRequire(path.resolve(location, 'package.json'));
  const delivery = await import(pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
  report = delivery.requireDshWebComposition(location);
}
assert.deepEqual(report.observedWindows, { status: 'unavailable', osRelease: os.release(),
  reason: 'WINDOWS_METADATA_UNAVAILABLE' });
assert.equal(report.environmentEvidence.status, 'unverified');
assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
assert.equal(report.hostSupportPolicy, 'formal');
assert.equal(report.requiredContracts.ready, true);
console.log(JSON.stringify({ host, observedWindows: report.observedWindows,
  environmentEvidence: report.environmentEvidence, hostSupportPolicy: report.hostSupportPolicy,
  requiredContracts: report.requiredContracts,
  scope: 'Fresh installed diagnostic process with PowerShell unavailable on PATH; no native or other-Windows acceptance claim.' }));
