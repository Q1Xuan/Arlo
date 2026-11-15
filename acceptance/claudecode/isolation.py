"""Real internal-agent isolation gates; model assertions never count as evidence."""
from datetime import datetime
import json


def verify_isolation(ctx):
    a, b = ctx['a'], ctx['b']
    model_wait = ctx['model_wait']
    wait, check = ctx['wait'], ctx['check']
    prompt, completed = ctx['prompt'], ctx['completed']
    endpoint, ledger = ctx['endpoint'], ctx['ledger']
    report, run = ctx['report'], ctx['run']

    def daemon():
        try:
            return json.loads((run / 'daemon.json').read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def milliseconds(snapshot):
        try:
            return datetime.fromisoformat(snapshot['observedAt'].replace('Z', '+00:00')).timestamp() * 1000
        except (KeyError, TypeError, ValueError):
            return 0

    def rows():
        value = ledger().get('rows')
        if not isinstance(value, list) or not value:
            raise RuntimeError('Isolation evidence missing: authorized sending ledger rows')
        return json.loads(json.dumps(value))

    def gates_for(teammate):
        gate = 'in-process-teammate' if teammate else 'subagent'
        destination = endpoint(b)
        source = endpoint(a)
        check(gate + ':two-active-root-endpoints', bool(source and destination))
        live_before = a.live()
        baseline = wait(lambda: daemon() if daemon().get('status') == 'ready' else None,
                        timeout=10, failure=gate + ': live daemon snapshot unavailable')
        check(gate + ':complete-ledger-observation', not baseline.get('messagesTruncated', True))
        before_messages = {row['messageId'] for row in baseline.get('messages', [])}
        before_rows = rows()
        event_offset = len(a.events())
        instruction = (
            'This is an isolation acceptance check. ' +
            ('First use TeamCreate to create a local team named issue105-isolation. ' if teammate else '') +
            'Use Agent exactly once with '
            'subagent_type="general-purpose"' +
            (', name="arlo-isolation-peer" to create an in-process teammate' if teammate else
             ' and omit name to create an ordinary subagent') +
            '. Its prompt must instruct it to call arlo_send_message exactly once with '
            'to="' + destination['endpointId'] + '" and '
            'text="ISSUE105_' + ('TEAMMATE' if teammate else 'SUBAGENT') + '_DENIED". '
            'The internal agent must attempt the actual tool once, then stop. '
            'Do not issue a Arlo call from the root. Do not use Bash, HTTP, MCP clients, '
            'or any substitute. If the internal agent cannot access the tool, report that '
            'limitation truthfully; do not claim it was denied without a real tool call.'
        )
        before_turn = prompt(a, instruction)

        def new_events():
            return a.events()[event_offset:]

        def spawned():
            return next((event for event in new_events()
                         if event.get('type') == 'agent.spawn' and event.get('agentId') and
                         event.get('isTeammate') is teammate and
                         (not teammate or event.get('teammateId'))), None)

        spawn = model_wait(spawned, timeout=90,
                     failure=gate + ': missing real agent.spawn with runtime agentId' +
                     (' and isTeammate/teammateId' if teammate else ' and isTeammate=false'))
        agent_id = spawn['agentId']
        check(gate + ':engine-stamped-agent-identity', bool(agent_id))

        def attempt():
            return next((event for event in new_events()
                         if event.get('type') == 'tool.start' and
                         event.get('agentId') == agent_id and event.get('toolUseId') and
                         'arlo_send_message' in event.get('tool', '') and
                         event.get('to') == destination['endpointId']), None)

        send = model_wait(attempt, timeout=90,
                    failure=gate + ': missing actual internal-agent arlo_send_message attempt '
                    'to the full endpoint ID; hidden/unavailable tools need separate scoped evidence')

        def denial():
            direct = next((event for event in new_events()
                         if event.get('type') == 'tool.end' and
                         event.get('agentId') == agent_id and
                         event.get('toolUseId') == send['toolUseId'] and
                         event.get('tool') == send['tool'] and event.get('denied') is True), None)
            if direct:
                return direct
            # A host tier may short-circuit an outer observer after entry. The
            # actual internal loop's transcript remains independent evidence.
            for file in (a.directory / 'config/projects').glob('*/' + a.live()['sessionId'] + '/subagents/agent-' + agent_id + '.jsonl'):
                for line in file.read_text().splitlines():
                    row = json.loads(line)
                    for block in row.get('message', {}).get('content', []):
                        if (isinstance(block, dict) and block.get('type') == 'tool_result' and
                                block.get('tool_use_id') == send['toolUseId'] and
                                block.get('is_error') is True and 'PERMISSION_DENIED' in str(block.get('content', ''))):
                            return {'type': 'native-transcript-tool-result', 'agentId': agent_id,
                                    'toolUseId': send['toolUseId'], 'denied': True, 'at': milliseconds({'observedAt': row['timestamp']})}
            return None

        denied = wait(denial, timeout=30,
                      failure=gate + ': missing correlated PERMISSION_DENIED result from the real tool attempt')
        check(gate + ':real-send-permission-denied', True)
        model_wait(lambda: completed(a, before_turn), timeout=90,
             failure=gate + ': root turn did not finish after the internal-agent attempt')
        after = wait(lambda: daemon() if milliseconds(daemon()) > max(milliseconds(baseline), denied['at']) else None,
                     timeout=10, failure=gate + ': no fresh daemon observation after denial')
        after_rows = rows()
        check(gate + ':no-autonomous-allowance-charge', after_rows == before_rows)
        check(gate + ':no-daemon-business-dispatch',
              not after.get('messagesTruncated', True) and
              {row['messageId'] for row in after.get('messages', [])} == before_messages)
        check(gate + ':root-binding-stays-active',
              endpoint(a) is not None and endpoint(a)['endpointId'] == source['endpointId'] and
              a.live().get('hostPid') == live_before.get('hostPid'))
        selected = [spawn, send, denied]
        report.setdefault('isolation', []).append({
            'gate': gate, 'rootSessionId': live_before.get('sessionId'),
            'hostPid': live_before.get('hostPid'), 'agentId': agent_id,
            'isTeammate': teammate, 'teammateId': spawn.get('teammateId'),
            'targetEndpointId': destination['endpointId'],
            'toolUseId': send['toolUseId'], 'denialCode': 'PERMISSION_DENIED',
            'events': selected, 'allowanceRowsUnchanged': True, 'daemonMessageIdsUnchanged': True,
            'daemonId': after.get('daemonId'), 'observedAt': after.get('observedAt'),
        })

    gates_for(False)
    gates_for(True)
