// Required scenarios are intentionally separate from supporting regression files.
// A green unit suite cannot promote an unexecuted host/platform scenario to passed.
const host = 'tests/windows-host-acceptance.test.ts';
const security = 'tests/windows-acceptance-security.test.ts';
const recovery = 'tests/harness-recovery-processes.test.ts';
const receipts = 'Two real Harnesses keep duplicate frames, late conflicting receipts and unloaded callbacks from repeating input';
const scenario = (id, criterion, title, evidenceLevel, tests, supportingFiles = [], gap = null) => ({
  id, criterion, title, required: true, platform: 'win32', evidenceLevel, tests, supportingFiles, gap,
});
const file = file => ({ file });
const named = (file, name) => ({ file, name });

export const scenarios = [
  scenario('host-processes', 1, 'Two independent published Harness runtimes, production plugin and real shared Daemon', 'harness-runtime-process', [named(host, 'Two real Harness processes discover, send and contextually reply through the shared Daemon without preemption')]),
  scenario('unicast-next-turn-reply', 2, 'Discovery, text unicast, model-visible associated reply, idle wake, busy queue, no preemption or parallel turns, no new Agent', 'harness-runtime-process', [named(host, 'Two real Harness processes discover, send and contextually reply through the shared Daemon without preemption')]),
  scenario('project-groups', 3, 'Worktree, clone, nested repository, explicit cross-project group, frozen membership and revocation', 'harness-runtime-process-with-fault-injection', [file('tests/project-groups-processes.test.ts')], ['tests/project-group-resolution.test.ts', 'tests/harness-project-groups.test.ts']),
  scenario('project-context-fallback', 3, 'Non-Git Workspace and missing trusted directory fail closed until explicit group selection', 'harness-runtime-process', [named('tests/harness-policy-processes.test.ts', 'Two real Harness processes require trusted project context and deliver after explicit group selection')], ['tests/harness-project-groups.test.ts', 'tests/project-group-resolution.test.ts']),
  scenario('windows-path-aliases', 3, 'Windows path case aliases and junction resolution through host discovery and delivery', 'harness-runtime-process-native-filesystem', [named('tests/project-groups-processes.test.ts', 'Real Windows junction and case alias reaches the repository')], ['tests/project-group-resolution.test.ts']),
  scenario('host-identities', 4, 'Real root/child callers, model-forged identity fields, replacement and duplicate integration', 'harness-runtime-process', [named(host, 'Real Harness identities resist child callers, forged fields, replacement and duplicate integrations')]),
  scenario('identity-registry-boundaries', 4, 'Multiple roots, same names and equal SessionId in different registries', 'harness-runtime-process', [named(host, 'Real Harness identities resist child callers, forged fields, replacement and duplicate integrations')], ['tests/root-session-regressions.test.ts', 'tests/root-session-daemon.test.ts', 'tests/mcp-binding-security.test.ts']),
  scenario('host-delivery-faults', 5, 'Dropped ACK, insertion failures, timeout, reconnect and Daemon restart without business resend', 'harness-runtime-process-with-fault-injection', [file('tests/harness-unicast-processes.test.ts'), file('tests/harness-recovery-processes.test.ts')]),
  scenario('receipt-history-combination', 5, 'Late/conflicting receipts, unavailable query and history evidence without reinsertion', 'harness-runtime-process-with-fault-injection', [file(recovery)], ['tests/message-status-query.test.ts', 'tests/message-status-regression.test.ts', 'tests/harness-replay-receipt.test.ts']),
  scenario('callback-lifecycle', 5, 'Old binding generation and post-unload callbacks cannot enter the host', 'harness-runtime-process-with-fault-injection', [file(recovery)], ['tests/harness-adapter-lifecycle.test.ts', 'tests/recovery-registration-disposal.test.ts']),
  scenario('bounded-host-queue', 6, 'Busy pending count/bytes, uncertain credit and release after consumption', 'harness-runtime-process-with-fault-injection', [file('tests/harness-unicast-processes.test.ts')]),
  scenario('duplicate-notifications', 6, 'Duplicate frame cannot produce repeated host input', 'harness-runtime-process-with-fault-injection', [named(recovery, receipts)], ['tests/harness-adapter-dedup.test.ts']),
  scenario('duplicate-business-requests', 6, 'Repeated authenticated MCP requests with one business UUID return one result and dispatch exactly one host notification', 'harness-runtime-process-with-request-replay', [named(recovery, receipts)], ['tests/daemon-replay-retention.test.ts']),
  scenario('notification-window', 6, 'Out-of-order notification and default 1024-position sliding-window edges', 'harness-runtime-process-with-fault-injection', [named(recovery, 'Two real Harnesses enforce out-of-order notification and sliding-window boundaries before host insertion')]),
  scenario('reconnect-pending', 6, 'Retained real host pending is reconciled after reconnect without replay', 'harness-runtime-process-with-fault-injection', [named(recovery, 'Two independent Harness processes recover a lost ACK and repeated disconnects without reinserting host input'), named(recovery, 'Two existing Harness processes survive a manually restarted Daemon without restoring old endpoints or pending proofs')], ['tests/harness-retained-reconnect.test.ts', 'tests/harness-capacity-recheck.test.ts']),
  scenario('receipt-eviction-tracking', 6, 'Default 1024-entry receipt-cache eviction and global tracking saturation in the two-process host combination', 'harness-runtime-process-controlled-daemon-clock-and-budget', [named('tests/harness-tracking-processes.test.ts', 'Two real Harnesses evict settled receipts without replay and bound global tracking across active and retired records')], ['tests/daemon-replay-retention.test.ts', 'tests/message-status-query.test.ts']),
  scenario('consumption-before-ack', 6, 'Actual host consumption sends released-message proof while delivery remains unknown, before late ACK', 'harness-runtime-process-with-fault-injection', [named(recovery, receipts)], ['tests/capacity-ack-window.test.ts', 'tests/capacity-ledger-recheck.test.ts', 'tests/harness-capacity-recheck.test.ts']),
  scenario('rates-reply-depth-combination', 6, 'Real model-issued calls across four Harness processes enforce default sender/receiver pacing and reply depth 8; rejection emits no notification', 'harness-runtime-process-controlled-daemon-clock', [named(recovery, 'Real Harness model calls enforce both default endpoint rates and the eight-level reply limit')], ['tests/daemon-rate-limit.test.ts', 'tests/reply-association.test.ts']),
  scenario('private-state-acl', 7, 'Native SID ACL rejects broad grants and unsafe filesystem locations', 'native-acl-filesystem', [file('tests/windows-security.test.ts'), named(security, 'Windows real daemon keeps state and rotated audit logs SID-private and excludes request canaries')]),
  scenario('startup-election', 7, 'Concurrent process startup converges on one shared Daemon and survives caller/owner exit', 'native-process', [
    named('tests/shared-daemon-start.test.ts', 'independent callers converge on one authenticated daemon which survives caller exit'),
    named('tests/shared-daemon-start.test.ts', 'a startup owner crashing before discovery does not strand another caller'),
    named('tests/shared-daemon-start.test.ts', 'a crashed shared daemon is replaced through OS ownership'),
  ]),
  scenario('pid-reuse', 7, 'Actual kernel PID recycling cannot transfer Daemon ownership or authorize killing the replacement', 'native-process', [file('tests/windows-pid-reuse.test.ts')], ['tests/daemon-serve-lifecycle.test.ts', 'tests/daemon-idle-exit.test.ts']),
  scenario('idle-exit-race', 7, 'Real process idle exit is canceled by admitted clients and ownership is released after disconnect', 'native-process', [named(security, 'Windows real daemon cancels idle exit for an admitted client and releases ownership after disconnect')], ['tests/daemon-idle-exit.test.ts']),
  scenario('host-idle-after-unload', 7, 'Consumed busy input followed by immediate plugin unload releases accounting and the shared Daemon exits naturally', 'harness-runtime-process', [named(host, 'Two real Harness processes discover, send and contextually reply through the shared Daemon without preemption'), file('tests/harness-unload-accounting.test.ts')]),
  scenario('old-port-certificate', 7, 'Independent old-port imposter gets zero plaintext before refusal; trusted positive control receives data', 'native-process-tls', [named(security, 'Windows separate old-port process receives zero plaintext before TLS refusal, with a working positive control')]),
  scenario('history-after-unload', 8, 'Arlo source serialization and history readability after plugin unload', 'harness-runtime-process', [named(host, 'Two real Harness processes discover, send and contextually reply through the shared Daemon without preemption')], ['probes/history-reader.test.ts']),
  scenario('host-input-policy', 8, 'Existing Harness tool permission and input policies remain enforced before, during and after Arlo integration', 'harness-runtime-process-public-policy-pipeline', [named('tests/harness-policy-processes.test.ts', 'Two real Harness processes preserve existing tool permission and input policies before, during and after Arlo integration')], ['probes/isolation.test.ts', 'probes/sandbox.test.ts']),
  scenario('audit-normal-rotation', 8, 'Real daemon state/log ACL, whitelist, rotation and canary exclusion', 'native-process-audit', [named(security, 'Windows real daemon keeps state and rotated audit logs SID-private and excludes request canaries')], ['tests/audit-logging.test.ts']),
  scenario('audit-all-fault-paths', 8, 'Normal, debug, over-limit, protocol and host exceptions satisfy log whitelist, rotation and no canary leak', 'harness-runtime-process-with-fault-injection', [file('tests/harness-audit-processes.test.ts')], ['tests/audit-logging.test.ts', 'tests/harness-unicast-processes.test.ts', 'tests/daemon-regressions.test.ts']),
  scenario('resource-isolation', 9, 'Owned private profile/config/project/process resources and zero supplier requests', 'runner-process-isolation', [{ runner: 'isolation' }]),
  scenario('cross-user-access', 9, 'Authorized temporary different-user SID cannot open private state or create files; positive control works and account is removed', 'native-authorized-temporary-user-token', [file('tests/windows-cross-user.test.ts')], ['tests/windows-security.test.ts']),
  scenario('reproducible-report', 10, 'Per-test status, source fingerprints, actual OS/runtime and unresolved evidence', 'runner-report', [{ runner: 'report' }]),
];

export function classifyFile(file) {
  if (file === host) return 'harness-runtime-process';
  if (file === security) return 'native-process-security';
  if (/harness.*processes|project-groups-processes/.test(file)) return 'harness-runtime-process-with-fault-injection';
  if (/windows-security|windows-pid-reuse|windows-cross-user|linux-|real-process-cli|shared-daemon-start/.test(file)) return 'native-platform-or-process';
  if (/harness-|root-session/.test(file)) return 'harness-runtime-in-process-or-adapter';
  return 'controlled-component';
}

// Shared product behavior must execute again on Linux. Only native platform
// requirements differ; a previous Windows result is never imported as evidence.
export function scenariosForPlatform(platform) {
  if (platform !== 'linux') return scenarios;
  const startup = 'tests/linux-startup.test.ts';
  const replacements = {
    'windows-path-aliases': {
      id: 'linux-path-semantics',
      title: 'Real Linux symlink discovery/delivery and case-distinct directories remain correctly scoped',
      tests: [
        named('tests/project-groups-processes.test.ts', 'Real Linux symlink reaches the repository'),
        named('tests/project-groups-processes.test.ts', 'Distinct Linux non-Git directories differing only by case remain isolated'),
      ],
    },
    'private-state-acl': {
      id: 'private-state-permissions',
      title: 'Native Linux XDG modes, ownership, unsafe ancestors, links and runtime/audit entries fail closed',
      evidenceLevel: 'native-linux-filesystem-and-process', tests: [file(startup)], supportingFiles: [],
    },
    'pid-reuse': {
      title: 'Actual kernel PID reuse in an unprivileged namespace cannot transfer ownership or kill an unrelated replacement',
      evidenceLevel: 'native-linux-pid-namespace', tests: [file('tests/linux-pid-reuse.test.ts')],
    },
    'idle-exit-race': {
      title: 'Independent Linux Daemon cancels idle exit for an admitted connection, then releases ownership naturally',
      tests: [file('tests/linux-idle-exit.test.ts')],
    },
    'old-port-certificate': {
      title: 'Every Linux reconnect authenticates before sending plaintext to an independent old-port imposter',
      tests: [
        named(startup, 'Linux pins every connection before a separate old-port imposter can receive plaintext'),
        named(startup, 'Linux cached SDK clients revalidate file-backed trust before transmitting any plaintext'),
      ],
    },
    'audit-normal-rotation': {
      title: 'Native Linux private audit rotation plus independent Daemon all-path whitelist and canary checks',
      tests: [named(startup, 'Linux normal, diagnostic, debug and rejected requests keep audit logs private and bounded'),
        file('tests/harness-audit-processes.test.ts')],
    },
    'cross-user-access': {
      id: 'foreign-ownership', criterion: 7,
      title: 'Real foreign-owned paths are rejected in an isolated namespace mapping only the invoking user; no host account creation',
      evidenceLevel: 'native-linux-user-mount-namespace',
      tests: [file('tests/linux-namespace-ownership.test.ts')], supportingFiles: ['tests/linux-ownership.test.ts'],
    },
  };
  return scenarios.map(scenario => ({ ...scenario, platform: 'linux', ...replacements[scenario.id] }));
}
