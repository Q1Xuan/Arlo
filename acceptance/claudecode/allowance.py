"""Explicit human commands and real model sends exercise persistent allowance."""
import hashlib
import json
import re
from datetime import datetime
import time


def verify_allowance(ctx):
    a, b = ctx['a'], ctx['b']
    model_wait = ctx['model_wait']
    ledger, command, wait, check = ctx['ledger'], ctx['command'], ctx['wait'], ctx['check']
    prompt, completed, endpoint = ctx['prompt'], ctx['completed'], ctx['endpoint']
    subject = hashlib.sha256(json.dumps(['claudecode', 'user-authorized', a.live()['sessionId']],
                                       separators=(',', ':')).encode()).hexdigest()

    def row():
        return next(value for value in ledger()['rows'] if value['subject'] == subject)

    before = row().copy()
    rules = ctx['run'] / 'state/autonomous-communication.json'
    rules.write_text(json.dumps({'version': 1, 'roots': {before['configId']: {'mode': 'bounded', 'grant': 1}}}))
    command(a, '/arlo-reload-sending-rules', 'Nextgrant:1')
    check('rules-reload-does-not-issue-allowance', row() == before)
    command(a, '/arlo-continue', 'Remaining:1')
    period = row().copy()
    check('explicit-continue-replaces-period', period['period'] != before['period'] and
          period['sequence'] == before['sequence'] + 1 and period['granted'] == 1 and period['used'] == 0)
    turn = prompt(a, ctx['send_request'](endpoint(b)['endpointId'], 'ISSUE105_LAST_ALLOWANCE'))
    ctx['verify_message'](a, b, 'ISSUE105_LAST_ALLOWANCE')
    model_wait(lambda: completed(a, turn))
    command(a, '/arlo-send-status', 'Pausereason:ALLOWANCE_EXHAUSTED')
    exhausted = row().copy()
    check('last-send-exhausts-allowance', exhausted['used'] == 1 and exhausted['period'] == period['period'])
    def daemon_snapshot():
        try:
            return json.loads((ctx['run'] / 'daemon.json').read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def observed_ms(value):
        try:
            return datetime.fromisoformat(value['observedAt'].replace('Z', '+00:00')).timestamp() * 1000
        except (KeyError, ValueError, AttributeError, TypeError):
            return 0

    def fresh_daemon(after_ms):
        snapshot = daemon_snapshot()
        if (snapshot.get('status') == 'ready' and isinstance(snapshot.get('messages'), list) and
                observed_ms(snapshot) > after_ms):
            return snapshot
        return None

    time_before = time.time() * 1000
    baseline = wait(lambda: fresh_daemon(time_before), timeout=10,
                    failure='Paused-send baseline daemon observation unavailable')
    check('paused-send-complete-daemon-baseline', baseline.get('messagesTruncated') is False)
    before_message_ids = {message['messageId'] for message in baseline['messages']}
    event_offset = len(a.events())
    destination = endpoint(b)['endpointId']
    paused_text = 'ISSUE105_MUST_BE_PAUSED: What is 23 + 19?'
    turn = prompt(a, 'For the sending limit test, attempt exactly one actual arlo_send_message to="' +
                  destination + '" text="' + paused_text + '". '
                  'Report its result and stop; do not retry.')
    model_wait(lambda: completed(a, turn))

    def attempts():
        return [event for event in a.events()[event_offset:] if event['type'] == 'tool.start' and
                not event.get('agentId') and event.get('toolUseId') and
                'arlo_send_message' in event.get('tool', '') and event.get('to') == destination]

    wait(attempts, timeout=15, failure='Exhausted allowance lacks an actual model send attempt')
    check('exhausted-model-send-attempted-once', len(attempts()) == 1)
    attempted = attempts()[0]
    native_calls = {}
    for record in a.transcript_rows():
        if record.get('type') != 'assistant':
            continue
        for block in record.get('message', {}).get('content', []):
            if (isinstance(block, dict) and block.get('type') == 'tool_use' and
                    block.get('id') == attempted['toolUseId'] and
                    'arlo_send_message' in block.get('name', '') and
                    block.get('input', {}).get('to') == destination and
                    block.get('input', {}).get('text') == paused_text):
                native_calls[block['id']] = block
    check('exhausted-native-model-send-input-matches', len(native_calls) == 1)

    def denial():
        direct = next((event for event in a.events()[event_offset:] if event['type'] == 'tool.end' and
                       not event.get('agentId') and event.get('toolUseId') == attempted['toolUseId'] and
                       event.get('tool') == attempted['tool'] and
                       event.get('toolErrorCode') == 'ALLOWANCE_EXHAUSTED'), None)
        if direct:
            return {'source': 'tool.end', 'toolUseId': attempted['toolUseId'], 'code': 'ALLOWANCE_EXHAUSTED'}
        # Claude may short-circuit the outer witness after production refusal.
        # Require the same actual native tool-use identity and error code;
        # assistant prose or an unmatched prior rejection cannot satisfy this.
        for record in a.transcript_rows():
            for block in record.get('message', {}).get('content', []):
                if (not isinstance(block, dict) or block.get('type') != 'tool_result' or
                        block.get('tool_use_id') != attempted['toolUseId'] or block.get('is_error') is not True):
                    continue
                content = block.get('content', '')
                text = content if isinstance(content, str) else '\n'.join(
                    item.get('text', '') for item in content if isinstance(item, dict) and item.get('type') == 'text'
                ) if isinstance(content, list) else ''
                if re.search(r'(?<![A-Z0-9_])ALLOWANCE_EXHAUSTED(?![A-Z0-9_])', text):
                    return {'source': 'native-transcript-tool-result', 'toolUseId': attempted['toolUseId'],
                            'code': 'ALLOWANCE_EXHAUSTED'}
        return None

    denied = wait(denial, timeout=15,
                  failure='Exhausted allowance lacks a correlated actual ALLOWANCE_EXHAUSTED tool result')
    check('exhausted-model-send-is-rejected', bool(denied))
    after_denial_ms = time.time() * 1000
    after_snapshot = wait(lambda: fresh_daemon(after_denial_ms), timeout=10,
                          failure='Paused-send fresh daemon observation after denial unavailable')
    check('paused-send-no-daemon-dispatch', after_snapshot.get('messagesTruncated') is False and
          after_snapshot.get('daemonId') == baseline.get('daemonId') and
          {message['messageId'] for message in after_snapshot['messages']} == before_message_ids)
    check('paused-send-does-not-dispatch-or-charge', ctx['received'](b, 'ISSUE105_MUST_BE_PAUSED') is None and row() == exhausted)
    command(a, '/arlo-continue', 'Remaining:1')
    continued = row().copy()
    check('human-continue-resumes-with-new-period', continued['sequence'] == exhausted['sequence'] + 1 and
          continued['period'] != exhausted['period'] and continued['used'] == 0)
    rules.write_text(json.dumps({'version': 1, 'roots': {continued['configId']: {'mode': 'continuous', 'grant': 1}}}))
    command(a, '/arlo-reload-sending-rules', 'Mode:continuous')
    before_continuous = ledger()
    command(a, '/arlo-continue', 'Mode:continuous')
    after_continuous = ledger()
    old_operations = {operation['id']: operation for operation in before_continuous['operations']}
    new_operations = [operation for operation in after_continuous['operations'] if operation['id'] not in old_operations]
    check('continuous-continue-leaves-allowance-unchanged', after_continuous['rows'] == before_continuous['rows'] and
          after_continuous['authority'] == before_continuous['authority'] and
          after_continuous['namespace'] == before_continuous['namespace'] and
          all(operation == old_operations[operation['id']] for operation in after_continuous['operations']
              if operation['id'] in old_operations) and len(new_operations) == 1 and
          len(after_continuous['operations']) == len(old_operations) + 1)
    result = new_operations[0].get('result', {})
    check('continuous-continue-commits-status-only-replay', result.get('mode') == 'continuous' and
          result.get('period_id') == continued['period'] and result.get('control_sequence') == continued['sequence'] and
          result.get('granted') == continued['granted'] and result.get('used') == continued['used'] and
          result.get('remaining') is None)
    ctx['report']['allowance'] = {'boundedGrant': 1, 'exhaustedUsed': 1,
        'firstPeriod': period['period'], 'resumedPeriod': continued['period'], 'continuousAllowanceUnchanged': True,
        'continuousStatusOnlyOperationCommitted': True,
        'exhaustedSendDenial': denied, 'pausedSendDaemonIdsUnchanged': True,
        'pausedSendDaemonId': after_snapshot['daemonId'], 'pausedSendObservedAt': after_snapshot['observedAt']}

