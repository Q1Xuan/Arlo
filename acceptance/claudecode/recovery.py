"""Real Sidecar faults at actual message boundaries, with no seeded records."""
import copy
import json


def verify_unknown_handoff(ctx):
    a, b = ctx['a'], ctx['b']
    model_wait = ctx['model_wait']
    wait, check, prompt = ctx['wait'], ctx['check'], ctx['prompt']
    run, endpoint, ledger = ctx['run'], ctx['endpoint'], ctx['ledger']
    completed, received = ctx['completed'], ctx['received']
    send_request = ctx['send_request']

    def daemon():
        return json.loads((run / 'daemon.json').read_text())

    def fact(identity):
        return next((row for row in daemon()['messages'] if row['messageId'] == identity), None)

    def daemon_endpoint(identity):
        return next((row for row in daemon()['endpoints'] if row['endpointId'] == identity), None)

    def reattached(before, old_endpoint):
        live = b.live()
        current = endpoint(b)
        retired = daemon_endpoint(old_endpoint)
        if (live.get('status') == 'active' and live.get('instanceId') and
                live['instanceId'] != before.get('instanceId') and live.get('generation', 0) > 0 and
                live.get('sidecarPid') != before['sidecarPid'] and current and
                current['endpointId'] != old_endpoint and retired and
                retired['ready'] is False and retired['deliverable'] is False):
            return current
        return None

    def security_for(live):
        file = b.directory / 'recovery.json'
        if file.exists():
            value = json.loads(file.read_text())
            if value.get('instanceId') == live['instanceId'] and value.get('newSidecarPid') == live['sidecarPid']:
                return value
        return None

    def action(value):
        file = b.directory / 'action.json'
        temporary = file.with_suffix('.tmp')
        temporary.write_text(json.dumps(value))
        temporary.replace(file)

    original = b.live().copy()
    original_endpoint = endpoint(b)['endpointId']
    before_ledger = copy.deepcopy(ledger())
    # The witness pauses the actual turn-start hook only long enough to kill
    # this root's Sidecar. The host has ingested the real message, but its claim
    # cannot be committed. Its model continues; no prompt is forged or replayed.
    action({'type': 'kill-on-marker'})
    wait(lambda: (b.directory / 'armed.json').exists(), timeout=10)
    sent = prompt(a, send_request(endpoint(b)['endpointId'], 'ISSUE105_UNKNOWN'))
    model_wait(lambda: (b.directory / 'fault.json').exists(),
         failure='Real handoff did not reach the armed Sidecar fault')
    first_endpoint = wait(lambda: reattached(original, original_endpoint), timeout=35,
         failure='Sidecar did not authenticate and reattach after real handoff fault')
    unknown = wait(lambda: received(b, 'ISSUE105_UNKNOWN') if received(b, 'ISSUE105_UNKNOWN') and
                   received(b, 'ISSUE105_UNKNOWN')['status'] == 'unknown' else None, timeout=15,
                   failure='Actual unconfirmed handoff did not recover as unknown')
    check('recovery-same-living-host-and-session', b.live()['hostPid'] == original['hostPid'] and
          b.live()['sessionId'] == original['sessionId'])
    security = wait(lambda: security_for(b.live()), timeout=15)
    check('recovery-stale-credential-and-instance-rejected', security['staleTokenStatus'] == 401 and
          security['staleInstanceStatus'] == 409)
    if ctx.get('interruptSenderAfterAcceptance'):
        wait(lambda: any(event['type'] == 'tool.end' and event.get('messageId') == unknown['messageId'] and
                         event.get('status') == 'accepted' for event in a.events()))
        # This diagnostic path cancels only the sender's optional post-result
        # narration, after its real tool result. The recipient turn is untouched.
        ctx['cancel'](a)
        ctx['report']['senderPostResultCancellationRequested'] = True
    model_wait(lambda: completed(a, sent), failure='Sender post-tool turn did not complete')
    model_wait(lambda: any(event['type'] == 'turn.complete' for event in b.events()
                    if unknown['correlationId'] in next((start.get('markers', []) for start in b.events()
                        if start.get('turnId') == event.get('turnId') and start['type'] == 'turn.start'), [])))
    marker_count = sum(unknown['correlationId'] in e.get('markers', []) for e in b.events())
    check('recovery-in-flight-input-not-resubmitted', marker_count == 1)
    check('recovery-old-unknown-credit-isolated-from-new-endpoint',
          fact(unknown['messageId']) and fact(unknown['messageId'])['holdsPendingCredit'] and
          fact(unknown['messageId'])['toEndpoint'] == original_endpoint and
          daemon_endpoint(original_endpoint)['pendingMessagesCount'] >= 1 and
          first_endpoint['pendingMessagesCount'] == 0)
    ctx['unknownRecord'] = unknown
    ctx['report']['unknownHandoff'] = {
        'hostPid': original['hostPid'], 'sessionId': original['sessionId'],
        'unknownMessageId': unknown['messageId'], 'unknownMarkerCount': marker_count,
        'originalEndpointId': original_endpoint,
        'replacementEndpointId': first_endpoint['endpointId'],
        'unknownCreditRetained': True, 'security': security,
    }
    return {'unknown': unknown, 'original': original, 'original_endpoint': original_endpoint,
            'first_endpoint': first_endpoint, 'before_ledger': before_ledger,
            'security': security, 'marker_count': marker_count, 'fact': fact,
            'daemon_endpoint': daemon_endpoint, 'reattached': reattached,
            'security_for': security_for, 'action': action}


def verify_recovery(ctx):
    # Make allowance preservation observable with nonzero consumption, and keep
    # a genuinely settled record in the root whose Sidecar will be interrupted.
    a, b = ctx['a'], ctx['b']
    model_wait = ctx['model_wait']
    wait, check, prompt = ctx['wait'], ctx['check'], ctx['prompt']
    completed, received = ctx['completed'], ctx['received']
    endpoint, send_request = ctx['endpoint'], ctx['send_request']
    debit = prompt(b, send_request(endpoint(a)['endpointId'], 'RECOVERY_CONSUMED_ALLOWANCE'))
    ctx['verify_message'](b, a, 'RECOVERY_CONSUMED_ALLOWANCE', reply=True)
    model_wait(lambda: completed(b, debit))
    settled_send = prompt(a, send_request(endpoint(b)['endpointId'], 'RECOVERY_SETTLED_INPUT'))
    settled = ctx['verify_message'](a, b, 'RECOVERY_SETTLED_INPUT', reply=True)
    model_wait(lambda: completed(a, settled_send))
    handoff = verify_unknown_handoff(ctx)
    a, b = ctx['a'], ctx['b']
    wait, check, prompt = ctx['wait'], ctx['check'], ctx['prompt']
    endpoint, ledger = ctx['endpoint'], ctx['ledger']
    completed, received = ctx['completed'], ctx['received']
    send_request = ctx['send_request']
    unknown, original = handoff['unknown'], handoff['original']
    original_endpoint, first_endpoint = handoff['original_endpoint'], handoff['first_endpoint']
    before_ledger, security = handoff['before_ledger'], handoff['security']
    marker_count, fact = handoff['marker_count'], handoff['fact']
    daemon_endpoint, reattached = handoff['daemon_endpoint'], handoff['reattached']
    security_for, action = handoff['security_for'], handoff['action']
    # A separate real message is durably accepted while B is working. Kill its
    # Sidecar after the foreground tool ends but before the root turn completes.
    # The Mod detects a failed bridge at idle; the remaining model turn must fit
    # Runner's existing 30-second recovery budget.
    busy_offset = len(b.events())
    busy_turn = prompt(b, 'For recovery acceptance run Bash command sleep 90 in the foreground with timeout 120000 '
                      'and run_in_background=false. Let it finish normally, then report timer finished.')
    model_wait(lambda: any(e['type'] == 'tool.start' and e.get('busyWork') for e in b.events()[busy_offset:]))
    queued_send = prompt(a, send_request(endpoint(b)['endpointId'], 'ISSUE105_RECOVER_QUEUED'))
    queued = wait(lambda: received(b, 'ISSUE105_RECOVER_QUEUED'), timeout=75)
    check('recovery-real-never-submitted-input-enqueued', queued['status'] == 'enqueued')
    busy_tool = next(e for e in b.events()[busy_offset:] if e['type'] == 'tool.start' and e.get('busyWork'))
    tool_end = wait(lambda: next((e for e in b.events()[busy_offset:] if e['type'] == 'tool.end' and
                    e.get('toolUseId') == busy_tool['toolUseId'] and e.get('busyWork')), None), timeout=120)
    check('recovery-fault-after-tool-before-root-turn-completes', not completed(b, busy_turn) and
          received(b, 'ISSUE105_RECOVER_QUEUED')['status'] == 'enqueued' and
          not any(queued['correlationId'] in e.get('markers', []) for e in b.events()))
    before_fault = b.live().copy()
    before_fault_endpoint = endpoint(b)['endpointId']
    check('recovery-queued-dispatch-owned-by-ending-endpoint', queued['dispatch']['endpoint_id'] == before_fault_endpoint)
    action({'type': 'kill-sidecar'})
    queued_fault = wait(lambda: json.loads((b.directory / 'queued-fault.json').read_text())
                        if (b.directory / 'queued-fault.json').exists() else None, timeout=10)
    second_endpoint = wait(lambda: reattached(before_fault, before_fault_endpoint), timeout=35,
                           failure='Sidecar did not authenticate a fresh endpoint within its recovery budget')
    second_security = wait(lambda: security_for(b.live()), timeout=15)
    check('second-recovery-stale-credential-and-instance-rejected',
          second_security['staleTokenStatus'] == 401 and second_security['staleInstanceStatus'] == 409)
    check('second-recovery-same-living-host-and-session', b.live()['hostPid'] == original['hostPid'] and
          b.live()['sessionId'] == original['sessionId'])
    check('recovery-old-queued-credit-isolated-from-new-endpoint',
          fact(queued['messageId']) and fact(queued['messageId'])['holdsPendingCredit'] and
          fact(queued['messageId'])['toEndpoint'] == before_fault_endpoint and
          daemon_endpoint(before_fault_endpoint)['pendingMessagesCount'] >= 1 and
          second_endpoint['pendingMessagesCount'] == 0)
    ctx['verify_message'](a, b, 'ISSUE105_RECOVER_QUEUED', reply=True, credit='retained')
    model_wait(lambda: completed(a, queued_send) and completed(b, busy_turn))
    busy_start = next(e for e in b.events() if e['type'] == 'turn.start' and
                      busy_turn in e.get('userPromptTags', []))
    busy_complete = next(e for e in b.events() if e['type'] == 'turn.complete' and
                         e.get('turnId') == busy_start['turnId'])
    check('recovery-actual-fault-before-root-turn-completes',
          tool_end['at'] <= queued_fault['killedAt'] < busy_complete['at'])
    check('recovery-never-submitted-input-ingested-once',
          sum(queued['correlationId'] in e.get('markers', []) for e in b.events()) == 1)
    queued_turn = next(e for e in b.events() if e['type'] == 'turn.start' and
                       queued['correlationId'] in e.get('markers', []))
    check('recovery-busy-tool-not-preempted', tool_end['at'] < queued_turn['at'])
    fresh_send = prompt(a, send_request(endpoint(b)['endpointId'], 'ISSUE105_AFTER_RECOVERY'))
    fresh = ctx['verify_message'](a, b, 'ISSUE105_AFTER_RECOVERY', reply=True)
    model_wait(lambda: completed(a, fresh_send))
    check('recovery-fresh-endpoint-releases-only-its-own-credit',
          fresh['dispatch']['endpoint_id'] == second_endpoint['endpointId'] and
          not fact(fresh['messageId'])['holdsPendingCredit'] and
          fact(queued['messageId'])['holdsPendingCredit'] and
          daemon_endpoint(second_endpoint['endpointId'])['pendingMessagesCount'] == 0 and
          daemon_endpoint(before_fault_endpoint)['pendingMessagesCount'] >= 1)
    check('recovery-unknown-stays-unknown-without-replay', received(b, 'ISSUE105_UNKNOWN')['status'] == 'unknown' and
          sum(unknown['correlationId'] in e.get('markers', []) for e in b.events()) == marker_count)
    # A's real sends consume A's allowance; recovery must change none of B's
    # durable authorization, grant, or consumption.
    # The complete B row is selected by the public session-derived subject hash.
    import hashlib
    b_subject = hashlib.sha256(json.dumps(['claudecode', 'user-authorized', original['sessionId']], separators=(',', ':')).encode()).hexdigest()
    before_b = next(row for row in before_ledger['rows'] if row['subject'] == b_subject)
    after_b = next(row for row in ledger()['rows'] if row['subject'] == b_subject)
    check('recovery-does-not-reset-consumed-root-allowance', before_b['used'] > 0 and before_b == after_b)
    # Committed human results live separately from allowance rows. Compare the
    # original authorize/continue operations, not just the current period.
    human_fingerprints = {
        hashlib.sha256(json.dumps([b_subject, kind, sequence], separators=(',', ':')).encode()).hexdigest()
        for kind, sequence in [('authorize', 0), ('continue', before_b['sequence'])]
    }
    before_actions = [operation for operation in before_ledger['operations']
                      if operation['fingerprint'] in human_fingerprints]
    after_operations = {operation['id']: operation for operation in ledger()['operations']}
    check('recovery-preserves-committed-human-action-results', len(before_actions) == 2 and
          all(operation.get('result') and operation == after_operations.get(operation['id'])
              for operation in before_actions))
    check('recovery-settled-input-stays-claimed-without-replay',
          received(b, 'RECOVERY_SETTLED_INPUT')['status'] == 'claimed' and
          sum(settled['correlationId'] in e.get('markers', []) for e in b.events()) == 1 and
          not fact(settled['messageId'])['holdsPendingCredit'])
    ctx['unknownRecord'] = unknown
    ctx['report']['recovery'] = {'hostPid': original['hostPid'], 'sessionId': original['sessionId'],
        'unknownMessageId': unknown['messageId'], 'unknownMarkerCount': marker_count,
        'queuedMessageId': queued['messageId'], 'freshMessageId': fresh['messageId'],
        'originalEndpointId': original_endpoint, 'firstReplacementEndpointId': first_endpoint['endpointId'],
        'secondReplacementEndpointId': second_endpoint['endpointId'],
        'recoveredQueuedCreditRetained': True, 'freshCreditReleased': True,
        'security': [security, second_security], 'allowanceUnchanged': True,
        'consumedAllowanceBefore': before_b['used'], 'consumedAllowanceAfter': after_b['used'],
        'committedHumanActionCount': len(before_actions), 'committedHumanActionsUnchanged': True,
        'settledMessageId': settled['messageId'], 'settledMarkerCount': 1}
    ctx['report']['recovery']['queuedFault'] = queued_fault

