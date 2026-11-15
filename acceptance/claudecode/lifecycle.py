"""Real TUI lifecycle gates; all messages originate from the model's Arlo tool."""
import copy
import hashlib
import json
from pathlib import Path


def verify_lifecycle(ctx):
    a, b = ctx['a'], ctx['b']
    model_wait = ctx['model_wait']
    wait, check, prompt = ctx['wait'], ctx['check'], ctx['prompt']
    command, endpoint, ledger = ctx['command'], ctx['endpoint'], ctx['ledger']
    report, run = ctx['report'], ctx['run']
    original = b.live()['sessionId']
    unknown = ctx.get('unknownRecord')
    check('lifecycle-real-unknown-record-required', isinstance(unknown, dict))
    message_id = unknown.get('messageId') or unknown.get('message_id')
    marker = unknown.get('correlationId')

    def records(session_id):
        file = run / 'state' / session_id / 'queue.jsonl'
        if not file.exists():
            return []
        return [json.loads(line) for line in file.read_text().splitlines() if line]

    def record(session_id, identity):
        return next((row for row in records(session_id) if row['messageId'] == identity), None)

    def daemon():
        return json.loads((run / 'daemon.json').read_text())

    def fact(identity):
        return next((row for row in daemon()['messages'] if row['messageId'] == identity), None)

    def revoked(identity):
        return any(row['endpointId'] == identity and row['status'] == 'revoked'
                   for row in daemon()['endpoints'])

    def marker_count(identity, after=0):
        return sum(identity in event.get('markers', []) for event in b.events()[after:]
                   if event['type'] == 'turn.start')

    unknown_row = record(original, message_id)
    check('lifecycle-unknown-from-current-real-root', bool(unknown_row and marker and
          unknown_row['status'] == 'unknown' and fact(message_id) and fact(message_id)['holdsPendingCredit']))
    original_endpoint = endpoint(b)['endpointId']
    original_attachment = b.live().copy()
    old_events = len(b.events())
    old_marker_count = marker_count(marker)

    def stale_attachment(before, name):
        result_file = b.directory / 'stale-attachment.json'
        result_file.unlink(missing_ok=True)
        action_file = b.directory / 'action.json'
        temporary = action_file.with_suffix('.tmp')
        probe_identity = {field: before[field] for field in ['sessionId', 'instanceId', 'generation']}
        temporary.write_text(json.dumps({'type': 'probe-stale-attachment', **probe_identity}))
        temporary.replace(action_file)
        def matching_result():
            result = json.loads(result_file.read_text()) if result_file.exists() else None
            return result if isinstance(result, dict) and all(
                result.get(field) == value for field, value in probe_identity.items()) else None
        result = wait(matching_result, timeout=10, failure=name + ': matching stale attachment result missing')
        check(name, result['status'] in [403, 409])
        report.setdefault('staleAttachments', []).append(result)

    def fresh_message(tag):
        turn = prompt(a, ctx['send_request'](endpoint(b)['endpointId'], tag))
        ctx['verify_message'](a, b, tag, reply=True)
        model_wait(lambda: ctx['completed'](a, turn))

    # Native slash commands are submitted at idle. The separate busy gate
    # already proves tool non-preemption; clear retains a real unknown handoff.
    before_controls = copy.deepcopy(ledger())
    command(b, '/clear')
    wait(lambda: b.live().get('sessionId') not in [None, original] and endpoint(b),
         timeout=20, failure='Native clear did not activate a verified replacement root')
    cleared = b.live()['sessionId']
    clear_endpoint = endpoint(b)['endpointId']
    check('clear-new-root-and-endpoint', clear_endpoint != original_endpoint)
    wait(lambda: revoked(original_endpoint), timeout=15, failure='Clear left the old endpoint registered')
    check('clear-official-ending-root-event', any(event['type'] == 'session.end' and
          event.get('reason') == 'clear' and event.get('sessionId') == original
          for event in b.events()[old_events:]))
    stale_attachment(original_attachment, 'clear-old-root-attachment-rejected')
    check('clear-keeps-real-unresolved-input', record(original, message_id)['status'] == 'unknown')
    check('clear-keeps-unresolved-pending-credit', fact(message_id) and fact(message_id)['holdsPendingCredit'])
    check('clear-new-root-never-ingests-old-unknown', marker_count(marker) == old_marker_count)
    command(b, '/arlo-root-config', 'AUTHORIZATION_REQUIRED')
    command(b, '/arlo-continue', 'ALLOWANCE_UNKNOWN')
    check('clear-does-not-authorize-or-grant', ledger() == before_controls)
    fresh_message('ISSUE105_AFTER_CLEAR')
    before_controls = copy.deepcopy(ledger())
    cleared_attachment = b.live().copy()

    command(b, '/resume ' + original)
    wait(lambda: b.live().get('sessionId') == original and endpoint(b), timeout=25,
         failure='Native resume did not return to the original root')
    resumed_endpoint = endpoint(b)['endpointId']
    wait(lambda: revoked(clear_endpoint), timeout=15, failure='Resume left the clear-root endpoint registered')
    check('resume-fresh-endpoint-original-root', resumed_endpoint not in [original_endpoint, clear_endpoint])
    stale_attachment(cleared_attachment, 'resume-old-root-attachment-rejected')
    command(b, '/arlo-send-status')
    check('resume-preserves-existing-allowance-and-controls', ledger() == before_controls)
    check('resume-keeps-real-unknown-without-replay', record(original, message_id)['status'] == 'unknown' and
          marker_count(marker) == old_marker_count)
    fresh_message('ISSUE105_AFTER_RESUME')
    before_controls = copy.deepcopy(ledger())

    # The Runner loads an exact private copy of the production Mod. Touching
    # that owned copy exercises native hot reload without editing repo sources.
    mod = b.directory / 'work' / 'production-mod' / 'hooks' / 'register.js'
    check('reload-private-production-mod-required', mod.is_file() and not mod.is_symlink())
    original_source = mod.read_bytes()
    original_hash = hashlib.sha256(original_source).hexdigest()
    shipped = Path(__file__).resolve().parents[2] / 'packages/adapter-claudecode/mod/hooks/register.js'
    check('reload-copy-matches-shipped-production-mod', original_source == shipped.read_bytes())
    before_reload = b.live().copy()
    before_endpoint = endpoint(b)
    after_reload = None
    try:
        mod.write_bytes(original_source + b'\n// Opt-in acceptance reload observation.\n')
        command(b, '/reload-plugins')
        wait(lambda: b.live().get('status') == 'active' and endpoint(b) and
             b.live().get('generation', 0) > before_reload.get('generation', 0), timeout=25,
             failure='Native changed-production-Mod reload did not replace its attachment')
        after_reload = b.live().copy()
        check('reload-same-root-new-attachment', after_reload['sessionId'] == original and
              after_reload['instanceId'] == before_reload.get('instanceId'))
        if before_endpoint:
            check('reload-preserves-root-endpoint', endpoint(b)['endpointId'] == before_endpoint['endpointId'])
        check('reload-preserves-allowance-and-controls', ledger() == before_controls)
        check('reload-unknown-never-replayed', record(original, message_id)['status'] == 'unknown' and
              marker_count(marker) == old_marker_count)
        stale_attachment(before_reload, 'reload-old-generation-rejected')
        fresh_message('ISSUE105_CHANGED_RELOAD')
        before_controls = copy.deepcopy(ledger())
    finally:
        mod.write_bytes(original_source)
    check('reload-private-source-restored', hashlib.sha256(mod.read_bytes()).hexdigest() == original_hash)
    check('reload-replacement-attachment-observed', isinstance(after_reload, dict))
    command(b, '/reload-plugins')
    wait(lambda: b.live().get('status') == 'active' and b.live().get('sessionId') == original and
         b.live().get('instanceId') == before_reload['instanceId'] and endpoint(b) and
         b.live().get('generation', 0) > after_reload['generation'], timeout=25,
         failure='Restored production Mod did not replace the temporary reload attachment')
    check('restored-mod-preserves-root-endpoint', endpoint(b)['endpointId'] == before_endpoint['endpointId'])
    check('restored-mod-preserves-ledger', ledger() == before_controls)
    check('restored-mod-unknown-never-replayed', record(original, message_id)['status'] == 'unknown' and
          marker_count(marker) == old_marker_count)
    stale_attachment(after_reload, 'restored-mod-old-generation-rejected')
    fresh_message('ISSUE105_AFTER_RELOAD')
    before_controls = copy.deepcopy(ledger())

    # Branch is the final native transition. An unverified new identity may
    # safely stop communication; that outcome need not reactivate the old root.
    branch_events = len(b.events())
    branch_capture = b.capture_offset()
    branch_previous_endpoint = endpoint(b)['endpointId']
    command(b, '/branch')

    def branch_ended():
        return any(event['type'] == 'session.end' and event.get('reason') == 'resume' and
                   event.get('sessionId') == original for event in b.events()[branch_events:])

    def branch_diagnostic():
        return 'Arlo communication stopped:' in b.text(branch_capture)

    def branch_result():
        live = b.live()
        current = endpoint(b)
        if not branch_ended() or not revoked(branch_previous_endpoint):
            return None
        if (live.get('status') == 'active' and live.get('sessionId') not in [None, original, cleared] and
                current and current['endpointId'] != branch_previous_endpoint):
            return 'active'
        if live.get('status') in ['draining', 'exhausted'] and current is None and branch_diagnostic():
            return 'stopped'
        return None

    outcome = wait(branch_result, timeout=25,
                   failure='Native branch produced neither verified replacement nor stopped diagnostic')
    check('branch-official-ending-root-event', branch_ended())
    check('branch-revokes-previous-endpoint', revoked(branch_previous_endpoint))
    branch_id = None
    if outcome == 'active':
        branch_id = b.live()['sessionId']
        command(b, '/arlo-root-config', 'AUTHORIZATION_REQUIRED')
        command(b, '/arlo-continue', 'ALLOWANCE_UNKNOWN')
        check('branch-new-root-is-unbound', branch_id not in [original, cleared] and ledger() == before_controls)
    else:
        check('branch-unverified-root-stops-with-diagnostic',
              branch_diagnostic() and revoked(branch_previous_endpoint) and endpoint(b) is None)
    check('branch-does-not-grant', ledger() == before_controls)
    check('branch-keeps-real-unknown-without-replay', record(original, message_id)['status'] == 'unknown' and
          marker_count(marker) == old_marker_count and fact(message_id)['holdsPendingCredit'])
    report['lifecycle'] = {'originalSessionId': original, 'clearSessionId': cleared,
                           'branchOutcome': outcome, 'branchSessionId': branch_id, 'unknownMessageId': message_id,
                           'unknownStatus': 'unknown',
                           'reloadGenerationBefore': before_reload.get('generation'),
                           'reloadGenerationAfter': after_reload['generation'],
                           'privateModSha256': original_hash, 'privateModRestored': True}
    return report['lifecycle']
