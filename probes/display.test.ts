import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidencePath = path.resolve(root, 'docs/compatibility/display-evidence.json');
const ss1Path = path.resolve(root, 'docs/compatibility/desktop-arlo-display.png');
const ss2Path = path.resolve(root, 'docs/compatibility/desktop-arlo-display-uninstalled.png');

test('installed Desktop renders Arlo as external before and after plugin removal', () => {
  assert.ok(existsSync(evidencePath), 'Desktop display verification evidence must exist; run pnpm test:gui to regenerate');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

  assert.equal(evidence.installedHostVerified, true, 'Desktop host integration must be verified');

  // Isolation and controlled local model verification
  assert.equal(evidence.isolation?.independentTestProfile, true, 'Must use independent test profile');
  assert.equal(evidence.isolation?.controlledLocalModelOnly, true, 'Must explicitly use controlled local model');
  assert.equal(evidence.isolation?.noUserCredentialsInherited, true, 'Must not inherit user credentials');
  assert.equal(evidence.isolation?.externalRequestDeniedProven, true, 'External request denial must be proven');
  assert.equal(evidence.isolation?.phase1HostExternalRequestsCount, 0, 'No unexpected external requests in phase 1 host');
  assert.equal(evidence.isolation?.phase2HostExternalRequestsCount, 0, 'No unexpected external requests in phase 2 host');
  assert.equal(evidence.isolation?.hostExternalRequestsCount, 0, 'No unexpected external requests in host');
  assert.equal(evidence.isolation?.phase1RendererExternalRequestsCount, 0, 'No unexpected external requests in phase 1 renderer');
  assert.equal(evidence.isolation?.phase2RendererExternalRequestsCount, 0, 'No unexpected external requests in phase 2 renderer');
  assert.equal(evidence.isolation?.rendererExternalRequestsCount, 0, 'No unexpected external requests in renderer');
  assert.equal(evidence.isolation?.rendererNetworkMonitored, true, 'Renderer network must be monitored');
  assert.equal(evidence.isolation?.externalNetworkCoverage, 'both_phases_host_and_renderer', 'Coverage must span both phases and both host/renderer');

  // Phase 1: With plugin installed
  assert.equal(evidence.phase1PluginPresent?.renderedAsTurnTrigger, true, 'Arlo message must render as external turn-trigger');
  assert.equal(evidence.phase1PluginPresent?.notHumanUserBubble, true, 'Arlo message must not render as human user bubble');
  assert.equal(evidence.phase1PluginPresent?.notSystemBubble, true, 'Arlo message must not render as system message');
  assert.ok(existsSync(ss1Path), 'Phase 1 display screenshot must exist');
  assert.ok(statSync(ss1Path).size > 1000, 'Phase 1 display screenshot must be non-empty');

  // Phase 2: With plugin uninstalled
  assert.equal(evidence.phase2PluginUninstalled?.safeHistoryRead, true, 'Historical session must load safely without plugin');
  assert.equal(evidence.phase2PluginUninstalled?.renderedAsTurnTrigger, true, 'Historical Arlo message must remain external turn-trigger without plugin');
  assert.equal(evidence.phase2PluginUninstalled?.notHumanUserBubble, true, 'Historical Arlo message must not render as human user bubble');
  assert.equal(evidence.phase2PluginUninstalled?.notSystemBubble, true, 'Historical Arlo message must not render as system message');
  assert.ok(existsSync(ss2Path), 'Phase 2 uninstalled display screenshot must exist');
  assert.ok(statSync(ss2Path).size > 1000, 'Phase 2 uninstalled display screenshot must be non-empty');
});
