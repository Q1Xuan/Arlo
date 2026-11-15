"""Linux #107 / Windows #108: Claude TUI, Pi TUI and persisted DSH runtime.

Opt-in only. Uses the production adapters and an unchanged Daemon. Public host
observations and the existing read-only Daemon observer are separate evidence.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
import pathlib
import platform
import re
import signal
import subprocess
import tempfile
import time
import uuid

from run import (BASE, REPO, Root, atomic, read_json, source_inventory, owns_run,
                 owned_processes, remove_owned_secrets)


def text_content(value):
    if isinstance(value, str):
        return value
    return '\n'.join(part.get('text', '') for part in (value or []) if part.get('type') == 'text')


def reply_match(tag, text):
    """Match this task's answer without accepting other tags or decimals."""
    return re.search(r'(?<!\w)' + re.escape(tag) + r'_REPLY\s*:\s*42\b(?![.,]\d)', text)


class Peer(Root):
    def __init__(self, run, label, node, env):
        super().__init__(run, label, node, env, worker='peer.mjs')

    def enter(self, text, *, deadline=None):
        self.check_input_deadline(deadline)
        if self.directory.name != 'b':
            # DSH uses a line-oriented public runtime, without a TUI editor.
            return super().enter(text, paste=False, deadline=deadline)
        def observe(predicate):
            until = time.monotonic() + 20
            while time.monotonic() < until:
                self.check_input_deadline(deadline)
                self.pump()
                if predicate():
                    return
                time.sleep(.025)
            raise RuntimeError('ACCEPTANCE_PI_NATIVE_EDITOR_SUBMISSION_MISSING')
        def draft():
            return next((row['text'] for row in reversed(self.native()) if row['type'] == 'draft'), None)
        observe(lambda: draft() == '')
        offset = len(self.native())
        self.write(('\x1b[200~' + text + '\x1b[201~').encode())
        observe(lambda: draft() == text)
        self.check_input_deadline(deadline)
        self.write(b'\r')
        observe(lambda: any(row['type'] == 'submit' and row.get('draft') == text for row in self.native()[offset:]))
        if text != '/quit':
            observe(lambda: draft() == '')

    def native(self):
        file = self.directory / 'native.private.jsonl'
        if not file.exists():
            return []
        # A final append may be in progress. Never accept a partial last row.
        return [json.loads(line) for line in file.read_text().splitlines(keepends=True) if line.endswith('\n')]

    def model_error(self):
        for row in self.native():
            if row['type'] == 'message' and row.get('message', {}).get('stopReason') == 'error':
                return 'PI_PROVIDER_ERROR'
            event = row.get('event', {})
            if event.get('type') != 'turn/end':
                continue
            reason = event.get('data', {}).get('reason')
            if not isinstance(reason, dict) or reason.get('kind') != 'error':
                continue
            error = reason.get('error')
            code = error.get('code') if isinstance(error, dict) else None
            if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code):
                return code
        return None

    def calls(self):
        if self.directory.name == 'b':
            return [{'id': row['id'], 'name': row['name'], 'args': row['args']} for row in self.native() if row['type'] == 'call']
        return [{'id': row['event']['data']['callId'], 'name': row['event']['data']['name'],
                 'args': json.loads(row['event']['data']['arguments'])}
                for row in self.native() if row['type'] == 'native' and row['event']['type'] == 'tool/call']

    def result(self, call_id):
        for row in self.native():
            if row['type'] == 'result' and row['id'] == call_id:
                return text_content(row['result'].get('content'))
            if row['type'] == 'native' and row['event']['type'] == 'tool/result':
                message = row['event']['data'].get('message', {})
                if message.get('toolCallId') == call_id:
                    return text_content(message.get('content'))
        return None

    def inputs(self):
        if self.directory.name == 'b':
            return [row['message'] for row in self.native() if row['type'] == 'message' and
                    row['message'].get('customType') == 'arlo-message']
        return [row['message'] for row in self.native() if row['type'] == 'claimed']

    def assistant_texts(self, after_ms=0):
        result = []
        for row in self.native():
            if row['at'] < after_ms:
                continue
            if row['type'] == 'message' and row['message'].get('role') == 'assistant':
                result.append(text_content(row['message'].get('content')))
            if row['type'] == 'native' and row['event']['type'] == 'assistant/message':
                result.append(text_content(row['event']['data'].get('message', {}).get('content')))
        return result

    def reception_diagnostic(self, tag, after_ms):
        observations = []
        for row in self.native():
            if row['at'] < after_ms:
                continue
            message = row.get('message', {}) if row['type'] == 'message' else row.get('event', {}).get('data', {}).get('message', {})
            if message.get('role') != 'assistant':
                continue
            text = text_content(message.get('content'))
            error = str(message.get('errorMessage', '')).lower()
            observations.append({'at': row['at'], 'textBytes': len(text.encode()),
                'sha256': hashlib.sha256(text.encode()).hexdigest(),
                'tagObserved': tag in text, 'replyLabelObserved': tag + '_REPLY' in text,
                'answer42Observed': bool(re.search(r'\b42\b', text)),
                'answerHasMarkdown': bool(re.search(r'[*_`]+42|42[*_`]+', text)),
                'stopReason': message.get('stopReason') if message.get('stopReason') in ['stop', 'length', 'toolUse', 'error', 'aborted'] else None,
                'providerErrorPresent': bool(error),
                'providerErrorClasses': [code for word, code in [('429', 'HTTP_429'), ('rate_limit', 'RATE_LIMIT'),
                    ('timeout', 'TIMEOUT'), ('401', 'HTTP_401'), ('403', 'HTTP_403'), ('overloaded', 'OVERLOADED'),
                    ('thinking', 'THINKING'), ('max_tokens', 'MAX_TOKENS')] if word in error]})
        return observations[-8:]

    def reception_complete(self, tag):
        rows = self.native()
        if self.directory.name == 'b':
            answered = [row for row in rows if row['type'] == 'message' and
                        row['message'].get('role') == 'assistant' and
                        tag + '_REPLY' in text_content(row['message'].get('content'))]
            return bool(answered) and any(row['type'] == 'settled' and row['at'] >= answered[-1]['at'] for row in rows)
        answered = [row for row in rows if row['type'] == 'native' and
                    row['event']['type'] == 'assistant/message' and
                    tag + '_REPLY' in text_content(row['event']['data'].get('message', {}).get('content'))]
        return bool(answered) and any(row['type'] == 'native' and row['event']['type'] == 'turn/end' and
            row['event']['data'].get('turn') == answered[-1]['event']['data']['turn'] for row in rows)


def claude_calls(root):
    return [{'id': block['id'], 'name': block['name'], 'args': block['input']}
            for row in root.transcript_rows() if row.get('type') == 'assistant'
            for block in row.get('message', {}).get('content', [])
            if isinstance(block, dict) and block.get('type') == 'tool_use']


def claude_prompts(root):
    """Human prompts exactly as the native Claude transcript recorded them."""
    return [text_content(row.get('message', {}).get('content')) for row in root.transcript_rows() if row.get('type') == 'user']


def claude_result(root, call_id):
    for row in root.transcript_rows():
        for block in row.get('message', {}).get('content', []):
            if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id') == call_id:
                return text_content(block.get('content'))
    return None


def stop_runners(roots):
    """Drain all live terminals until every runner stops, then close them all."""
    def drain_until(predicate, seconds):
        until = time.monotonic() + seconds
        while not predicate() and time.monotonic() < until:
            for root in roots:
                root.pump()
            time.sleep(.05)
        return predicate()

    all_exited = lambda: all(root.process.poll() is not None for root in roots)
    if not drain_until(all_exited, 15):
        for root in roots:
            if root.process.poll() is None:
                root.process.terminate()
        if not drain_until(all_exited, 5):
            for root in roots:
                if root.process.poll() is None:
                    if os.name == 'nt':
                        root.process.kill()
                    else:
                        os.killpg(root.process.pid, signal.SIGKILL)
            drain_until(all_exited, 5)
    for root in roots:
        root.process.wait(timeout=1)
        root.pump()
    for root in roots:
        root.terminal.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-real-models', action='store_true', required=True)
    parser.add_argument('--node', default=os.environ.get('ARLO_ACCEPTANCE_NODE', 'node'))
    parser.add_argument('--pnpm', default=os.environ.get('ARLO_ACCEPTANCE_PNPM', 'pnpm'))
    parser.add_argument('--scenario', choices=['startup', 'exchange', 'matrix', 'all'], default='all')
    parser.add_argument('--timeout-seconds', type=int, default=1800)
    parser.add_argument('--max-prompts', type=int, default=40)
    parser.add_argument('--model-turn-timeout-seconds', type=int, default=600)
    parser.add_argument('--report', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.timeout_seconds <= 3600 or not 1 <= args.max_prompts <= 80 or not 1 <= args.model_turn_timeout_seconds <= 3600:
        parser.error('Use 1..3600 second budgets and 1..80 human model prompts')
    os.umask(0o077)
    package = read_json(REPO / 'package.json')
    node_version = subprocess.check_output([args.node, '--version'], text=True).strip()
    if node_version != 'v' + package['engines']['node']:
        raise RuntimeError('Pinned Node version required')
    pnpm_version = subprocess.check_output([args.node, args.pnpm, '--version'], text=True).strip() if args.pnpm.endswith('.cjs') else subprocess.check_output([args.pnpm, '--version'], text=True).strip()
    if package['packageManager'] != 'pnpm@' + pnpm_version:
        raise RuntimeError('Pinned pnpm version required')
    sources = source_inventory()
    owner = str(uuid.uuid4())
    issue = 108 if os.name == 'nt' else 107
    run = pathlib.Path(tempfile.mkdtemp(prefix='arlo-issue' + str(issue) + '-',
        dir=pathlib.Path.home() if os.name == 'nt' else None))
    # Reuse the #105 resource/cleanup library, including its owner contract.
    atomic(run / '.arlo-owner.json', {'owner': owner, 'purpose': 'issue105-real-acceptance'})
    if os.name == 'nt':
        from windows import protect_run
        protect_run(run, owner, args.node)
    (run / 'state').mkdir(mode=0o777 if os.name == 'nt' else 0o700)
    env = {**os.environ, 'ARLO_ACCEPTANCE_ROOT': str(run), 'ARLO_ACCEPTANCE_OWNER': owner,
           'PATH': str(pathlib.Path(args.node).parent) + os.pathsep + os.environ['PATH'],
           'TERM': 'xterm-256color', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
           'ARLO_ACCEPTANCE_MODEL_TIMEOUT_MS': str(args.model_turn_timeout_seconds * 1000),
           'DISABLE_TELEMETRY': '1', 'ANTHROPIC_MAX_RETRIES': '0'}
    report = {'schemaVersion': 2, 'issue': issue, 'passed': False, 'allRuntimeGatesPassed': False, 'scenario': args.scenario,
              'platform': platform.system().lower(), 'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
              'node': node_version, 'pnpm': pnpm_version, 'packageManager': package['packageManager'], 'sources': sources,
              'claude': subprocess.check_output([os.environ.get('ARLO_ACCEPTANCE_CLAUDE', 'claude'), '--version'], text=True).strip(),
              'startedAt': datetime.now().astimezone().isoformat(), 'kernel': platform.version() if os.name == 'nt' else platform.release(),
              'terminal': 'Claude and Pi ' + ('Windows ConPTY' if os.name == 'nt' else 'Linux PTY') + ' 48x170; DSH public runtime stdin',
              'budget': {'timeoutSeconds': args.timeout_seconds, 'maxHumanModelPrompts': args.max_prompts,
                         'modelObservationSeconds': args.model_turn_timeout_seconds,
                         'additionalIncomingAndToolContinuationRequests': True},
              'hostedCI': 'excluded-by-user', 'checks': [], 'messages': [], 'matrix': []}
    if os.name == 'nt':
        from importlib.metadata import version
        from windows import filesystem
        report['filesystems'] = {'source': filesystem(REPO), 'privateState': filesystem(run)}
        report['acceptanceTools'] = {name: version(name) for name in ['pywinpty', 'psutil', 'pyte', 'wcwidth']}
        report['acceptanceTools']['python'] = platform.python_version()
    else:
        report['os'] = dict(line.strip().split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if line.startswith(('ID=', 'VERSION_ID=')))
        report['filesystems'] = subprocess.check_output(['stat', '-f', '-c', '%T', str(REPO), str(run)], text=True).splitlines()
    deadline = time.monotonic() + args.timeout_seconds
    roots = []
    daemon = None
    daemon_log = None
    prompts = 0

    def wait(predicate, timeout=None, failure='Acceptance condition timed out'):
        until = min(deadline, time.monotonic() + (args.model_turn_timeout_seconds if timeout is None else timeout))
        while time.monotonic() < until:
            for root in roots:
                root.pump()
                if isinstance(root, Peer) and root.model_error():
                    raise RuntimeError('ACCEPTANCE_PEER_MODEL_ERROR_' + root.model_error())
                if root.process.poll() is not None:
                    raise RuntimeError('ACCEPTANCE_HOST_EXITED_' + root.directory.name)
            value = predicate()
            if value:
                return value
            time.sleep(.1)
        raise RuntimeError(failure)

    def check(name, value):
        report['checks'].append({'name': name, 'passed': bool(value)})
        print(json.dumps({'check': name, 'passed': bool(value)}), flush=True)
        if not value:
            raise RuntimeError(name)

    def snapshot():
        return read_json(run / 'daemon.json', {})

    def endpoint(root):
        return next((row for row in snapshot().get('endpoints', []) if row['sessionId'] == root.live().get('sessionId')
                     and row['status'] == 'registered' and row['ready']), None)

    def command(root, text, expected):
        native_offset = len(root.native()) if isinstance(root, Peer) else 0
        event_offset = len(root.events()) if not isinstance(root, Peer) else 0
        root.enter(text, deadline=deadline)
        if root.directory.name == 'c':
            row = wait(lambda: next((event for event in root.native()[native_offset:]
                if event['type'] == 'command' and event.get('name') == text.split()[0]), None), timeout=30,
                failure='DSH human command result missing')
            if text.startswith('/arlo-settings'):
                check('DSH-setting-confirmed-' + text.split()[-1], row['result']['effective'] == (text.endswith('on')))
            return row.get('result')
        if not isinstance(root, Peer):
            def command_result():
                for event in root.events()[event_offset:]:
                    if (event['type'] != 'command.result' or event.get('command') != text.split()[0].lstrip('/') or
                            event.get('originKind') != 'composer' or event.get('outputObserved') is not True):
                        continue
                    if text.startswith('/arlo-settings'):
                        if event.get('crossHostEnabled') is (text.endswith('on')):
                            return event
                    else:
                        rendered = {key + ':' + str(event[field]) for key, field in
                            [('Mode', 'mode'), ('Remaining', 'remaining'), ('Nextgrant', 'nextGrant'), ('Pausereason', 'pauseReason')] if field in event}
                        if event.get('authorizationSucceeded'):
                            rendered.add('用户已授权绑定')
                        if expected in rendered:
                            return event
                return None
            event = wait(command_result, timeout=30, failure='Claude native command event missing: ' + text.split()[0])
            report.setdefault('commands', []).append({'root': root.directory.name, 'command': text.split()[0], 'nativeEvent': event})
            return event
        # A redraw may repeat an earlier status before this command completes.
        # Only its fresh passive native notification can supply current usage.
        event = wait(lambda: next((event for event in root.native()[native_offset:]
            if event['type'] == 'command' and expected in re.sub(r'\s+', '', event.get('text', ''))), None),
            timeout=30, failure='Pi native command result missing: ' + text.split()[0])
        return {match.group(1): match.group(2) for match in re.finditer(r'^(Period|Used|Remaining): (.+)$', event['text'], re.M)}

    def calls(root):
        return root.calls() if isinstance(root, Peer) else claude_calls(root)

    def result(root, call_id):
        return root.result(call_id) if isinstance(root, Peer) else claude_result(root, call_id)

    def settled(root, after_ms):
        if isinstance(root, Peer):
            return any(row['type'] == 'settled' and row['at'] >= after_ms for row in root.native())
        events = root.events()
        starts = [e for e in events if e['type'] == 'turn.start' and e['at'] >= after_ms and not e.get('markers')]
        return bool(starts) and any(e['type'] == 'turn.complete' and e.get('turnId') == starts[-1]['turnId'] for e in events)

    def send(sender, receiver, tag, expected='accepted', reply_to=None, reply_from=None):
        nonlocal prompts
        prompts += 1
        if prompts > args.max_prompts:
            raise RuntimeError('ACCEPTANCE_HUMAN_PROMPT_BUDGET_EXHAUSTED')
        destination = endpoint(receiver)['endpointId']
        report['currentTag'] = tag
        marker_instruction = ' Include the entire accompanying correlation marker, including square brackets, literal arlo-correlation: prefix and actual UUID unchanged. Never send automatically.'
        body = tag + ': What is 23 + 19? Compute the sum locally. Start your answer with the literal label ' + tag + '_REPLY: followed by your computed integer answer.' + marker_instruction
        answer = None
        if reply_from:
            answer = next((match.group(0) for text in sender.assistant_texts()
                           if (match := reply_match(reply_from['tag'], text))), None)
            if not answer:
                raise RuntimeError(tag + ':original-model-business-answer-missing')
            body = tag + ': Forwarded business answer to message ' + reply_from['messageId'] + ': ' + answer + '. Confirm receipt locally with the literal label ' + tag + '_REPLY: followed by the received integer answer.' + marker_instruction
        payload = {'to': destination, 'text': body}
        if reply_to:
            payload['reply_to'] = reply_to
        baseline = snapshot()
        check(tag + ':complete-observer', baseline.get('messagesTruncated') is False)
        before_ids = {row['messageId'] for row in baseline['messages']}
        before_calls = {row['id'] for row in calls(sender)}
        started = time.time() * 1000
        # ISSUE105 tag is understood by the existing passive Claude witness.
        prompt_tag = 'ISSUE105_USER_' + str(prompts).zfill(4)
        reply_instruction = ('Use the supplied reply_to exactly.' if reply_to else
                             'This is a new task: omit the optional reply_to property entirely. Do not use an empty string, null, or any earlier message ID.')
        request = (prompt_tag + ': Call arlo_send_message exactly once with this exact JSON: ' + json.dumps(payload) +
                   '. This object is the top-level tool arguments: text must contain only the text property value, never this entire serialized JSON object. Copy the JSON string values verbatim, including punctuation. Do not answer the question inside text, replace labels, or rewrite any part of text before sending. ' + reply_instruction + ' This is a new explicit human send request. Even if cached settings say off, attempt the tool once to verify its error. Never retry or substitute another tool, including after a validation error. Stop after the first tool result.')
        report['currentPromptBytes'] = len(request.encode())
        recorded = None if isinstance(sender, Peer) else len(claude_prompts(sender))
        sender.enter(request, deadline=deadline)
        if recorded is not None:
            # Native submission evidence, separate from the model's tool call.
            wait(lambda: request in claude_prompts(sender)[recorded:], timeout=60,
                 failure=tag + ':claude-native-prompt-not-recorded-exactly')
        call = wait(lambda: next((row for row in calls(sender) if row['id'] not in before_calls and
                    'arlo_send_message' in row['name'] and row['args'] == payload), None),
                    failure=tag + ':exact-model-tool-call-missing')
        returned = wait(lambda: result(sender, call['id']), failure=tag + ':native-tool-result-missing')
        wait(lambda: settled(sender, started), failure=tag + ':sender-turn-incomplete')
        check(tag + ':single-model-send-attempt', len([row for row in calls(sender) if row['id'] not in before_calls and 'arlo_send_message' in row['name']]) == 1)
        evidence = {'tag': tag, 'sender': sender.directory.name, 'receiver': receiver.directory.name,
                    'modelToolUseId': call['id'], 'expected': expected, 'replyTo': reply_to,
                    'businessAnswer': {'sourceMessageId': reply_from['messageId'], 'sourceTag': reply_from['tag'],
                        'sha256': hashlib.sha256(answer.encode()).hexdigest()} if answer else None}
        if expected != 'accepted':
            check(tag + ':daemon-error', expected in returned)
            fresh = wait(lambda: snapshot() if snapshot().get('observedAt', '') > baseline.get('observedAt', '') else None, timeout=10)
            check(tag + ':no-dispatch', {row['messageId'] for row in fresh['messages']} == before_ids)
            evidence['errorCode'] = expected
            report['messages'].append(evidence)
            return evidence
        returned_json = json.loads(returned)
        check(tag + ':accepted-tool-result', returned_json['status'] == 'accepted')
        message_id = returned_json['message_id']
        fact = wait(lambda: next((row for row in snapshot().get('messages', []) if row['messageId'] == message_id and
                    row['status'] == 'accepted' and not row['holdsPendingCredit']), None), timeout=180,
                    failure=tag + ':daemon-credit-release-missing')
        check(tag + ':exact-endpoints-and-reply', fact['fromEndpoint'] == endpoint(sender)['endpointId'] and
              fact['toEndpoint'] == destination and fact['replyTo'] == reply_to)
        if isinstance(receiver, Peer):
            inbound = wait(lambda: next((row for row in receiver.inputs() if body in text_content(row.get('content'))), None),
                           failure=tag + ':host-input-missing')
            check(tag + ':native-host-input', message_id in text_content(inbound.get('content')) or
                  message_id == inbound.get('details', {}).get('message_id') or
                  any(row.get('message_id') == message_id for row in inbound.get('details', {}).get('messages', [])))
            marker = None
        else:
            queue = run / 'state' / receiver.live()['sessionId'] / 'queue.jsonl'
            def queue_row():
                if not queue.exists():
                    return None
                return next((json.loads(line) for line in queue.read_text().splitlines()
                    if json.loads(line).get('messageId') == message_id and json.loads(line).get('status') == 'claimed'), None)
            inbound = wait(queue_row, failure=tag + ':claimed-queue-row-missing')
            marker = inbound['correlationId']
            turns = [row for row in receiver.events() if row['type'] == 'turn.start' and marker in row.get('markers', [])]
            check(tag + ':claude-claim-own-turn-marker', len(turns) == 1 and
                  fact['deliveryId'] == inbound['dispatch']['delivery_id'] and fact['nativeMessageId'] == inbound['nativeMessageId'])
        try:
            wait(lambda: any(reply_match(tag, text) and
                             (marker is None or '[arlo-correlation:' + marker + ']' in text)
                             for text in receiver.assistant_texts(started)), failure=tag + ':separate-correlated-model-reply-missing')
        except RuntimeError:
            evidence.update({'messageId': message_id, 'daemon': fact, 'hostInputObserved': True,
                'modelReplyObserved': False, 'correlationId': marker})
            if isinstance(receiver, Peer):
                evidence['replyDiagnostic'] = receiver.reception_diagnostic(tag, started)
            report['messages'].append(evidence)
            raise
        if isinstance(receiver, Peer):
            wait(lambda: receiver.reception_complete(tag), failure=tag + ':native-reception-turn-incomplete')
        else:
            wait(lambda: any(event['type'] == 'turn.complete' and event.get('turnId') == turns[0]['turnId'] for event in receiver.events()), failure=tag + ':native-reception-turn-incomplete')
        check(tag + ':model-reply-and-credit-separate', True)
        evidence.update({'messageId': message_id, 'daemon': fact, 'hostInputObserved': True,
                         'modelReplyObserved': True, 'correlationId': marker})
        report['messages'].append(evidence)
        return evidence

    try:
        daemon_log = open(run / 'daemon.stderr', 'wb')
        daemon = subprocess.Popen([args.node, str(BASE / 'daemon.mjs')], cwd=REPO, env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=daemon_log)
        wait(lambda: snapshot().get('status') == 'ready', timeout=20, failure='ACCEPTANCE_DAEMON_START_FAILED')
        roots.append(Root(run, 'a', args.node, env))
        roots.extend(Peer(run, label, args.node, env) for label in ['b', 'c'])
        print(json.dumps({'run': str(run), 'phase': 'starting-three-live-hosts'}), flush=True)
        for root in roots:
            wait(lambda: endpoint(root), timeout=120, failure='ACCEPTANCE_HOST_NOT_READY_' + root.directory.name)
        claude, pi, dsh = roots
        report['hosts'] = [{'label': root.directory.name, 'sessionId': root.live()['sessionId'],
                            'endpointId': endpoint(root)['endpointId'],
                            'version': report['claude'] if root is claude else read_json(REPO / ('packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/package.json' if root is pi else 'node_modules/@deepseek-ai/dsh-agent/package.json'))['version'],
                            'hostKind': 'claudecode' if root is claude else ('pi' if root is pi else 'deepseek-harness')} for root in roots]
        check('three-real-roots-one-unchanged-daemon', len({row['endpointId'] for row in report['hosts']}) == 3)
        command(claude, '/arlo-authorize', '用户已授权绑定')
        ledger = lambda: read_json(run / 'state/user-authorized-roots.json', {})
        check('claude-authorize-does-not-grant', len(ledger().get('rows', [])) == 1 and ledger()['rows'][0]['period'] is None)
        command(claude, '/arlo-continue', 'Remaining:20')
        for peer in [pi, dsh]:
            command(peer, '/arlo-settings on', 'Cross-hostcommunicationenabled')
        command(claude, '/arlo-settings on', 'Cross-hostcommunication:on')
        for peer in ([] if args.scenario == 'startup' else [pi, dsh]):
            pair = 'PI' if peer is pi else 'DSH'
            forward = send(claude, peer, 'ISSUE107_CLAUDE_TO_' + pair)
            send(peer, claude, 'ISSUE107_' + pair + '_TO_CLAUDE_REPLY', reply_to=forward['messageId'], reply_from=forward)
            reverse = send(peer, claude, 'ISSUE107_' + pair + '_TO_CLAUDE_TASK')
            send(claude, peer, 'ISSUE107_CLAUDE_TO_' + pair + '_REPLY', reply_to=reverse['messageId'], reply_from=reverse)
        if args.scenario in ['matrix', 'all']:
            for peer in [pi, dsh]:
                pair = 'PI' if peer is pi else 'DSH'
                for a_on, p_on in [(True, True), (False, True), (True, False), (False, False)]:
                    before = ledger()['rows'][0].copy()
                    peer_before = command(peer, '/arlo-send-status', 'ARLO_STATUS_PLACEHOLDER' if peer is dsh else 'Arlodispatchattempts')
                    original_endpoints = [endpoint(root)['endpointId'] for root in [claude, peer]]
                    command(claude, '/arlo-settings ' + ('on' if a_on else 'off'), 'Cross-hostcommunication:' + ('on' if a_on else 'off'))
                    command(peer, '/arlo-settings ' + ('on' if p_on else 'off'), 'Cross-hostcommunication' + ('enabled' if p_on else 'disabled'))
                    check('saved-participation-preferences', read_json(run / 'state/claudecode/arlo.json', {}).get('crossHostEnabled') is a_on and read_json(peer.directory / 'config/arlo.json', {}).get('crossHostEnabled') is p_on)
                    error = 'accepted' if a_on and p_on else 'CROSS_HOST_DISABLED'
                    prefix = 'ISSUE107_' + pair + '_' + str(int(a_on)) + str(int(p_on))
                    send(claude, peer, prefix + '_FORWARD', error)
                    send(peer, claude, prefix + '_REVERSE', error)
                    after = ledger()['rows'][0]
                    check(prefix + ':period-retained', after['period'] == before['period'])
                    check(prefix + ':daemon-attempt-accounting', after['used'] == before['used'] + int(a_on and p_on))
                    peer_after = command(peer, '/arlo-send-status', 'ARLO_STATUS_PLACEHOLDER' if peer is dsh else 'Arlodispatchattempts')
                    if peer is dsh:
                        check(prefix + ':peer-period-and-usage', peer_after['period_id'] == peer_before['period_id'] and peer_after['used'] == peer_before['used'] + int(a_on and p_on))
                    else:
                        check(prefix + ':peer-period-and-usage', peer_after['Period'] == peer_before['Period'] and int(peer_after['Used']) == int(peer_before['Used']) + int(a_on and p_on))
                    check(prefix + ':endpoints-retained', original_endpoints == [endpoint(root)['endpointId'] for root in [claude, peer]])
                    report['matrix'].append({'peer': pair, 'claudeEnabled': a_on, 'peerEnabled': p_on, 'bothDirectionsChecked': True})
                command(claude, '/arlo-settings on', 'Cross-hostcommunication:on')
                command(peer, '/arlo-settings on', 'Cross-hostcommunicationenabled')
                reopened = send(claude, peer, 'ISSUE107_' + pair + '_REOPEN')
                send(peer, claude, 'ISSUE107_' + pair + '_REOPEN_REPLY', reply_to=reopened['messageId'], reply_from=reopened)
        if args.scenario == 'all':
            before = ledger()['rows'][0].copy()
            rules = run / 'state/autonomous-communication.json'
            configured = read_json(rules, {'version': 1, 'roots': {}})
            configured['roots'][before['configId']] = {'mode': 'bounded', 'grant': 1}
            atomic(rules, configured)
            command(claude, '/arlo-reload-sending-rules', 'Nextgrant:1')
            check('rule-reload-does-not-grant', ledger()['rows'][0] == before)
            command(claude, '/arlo-continue', 'Remaining:1')
            final = send(claude, pi, 'ISSUE107_LAST_ALLOWANCE')
            send(pi, claude, 'ISSUE107_EXHAUSTED_CAN_RECEIVE', reply_to=final['messageId'], reply_from=final)
            send(claude, pi, 'ISSUE107_EXHAUSTED_SEND', 'ALLOWANCE_EXHAUSTED')
            exhausted = ledger()['rows'][0].copy()
            command(claude, '/arlo-continue', 'Remaining:1')
            check('explicit-continue-replaces-period', ledger()['rows'][0]['period'] != exhausted['period'])
            continued = send(claude, pi, 'ISSUE107_AFTER_CONTINUE')
            send(pi, claude, 'ISSUE107_AFTER_CONTINUE_REPLY', reply_to=continued['messageId'], reply_from=continued)
        report['passed'] = True
    except KeyboardInterrupt:
        report['error'] = 'ACCEPTANCE_INTERRUPTED'
    except Exception as error:
        # Only fixed driver messages reach the report; never raw host/API errors.
        report['error'] = str(error) if isinstance(error, RuntimeError) else 'ACCEPTANCE_DRIVER_FAILED_' + type(error).__name__
        report['peerDiagnostics'] = [{'label': root.directory.name, 'modelErrorCode': root.model_error(), 'assistantObservations': root.reception_diagnostic(report.get('currentTag', 'NO_TAG'), 0),
            'nativePromptTags': [row.get('userTags', []) for row in root.native() if row['type'] == 'prompt'][-8:],
            'sendCalls': [{'toolUseId': call['id'], 'to': call['args'].get('to'), 'replyTo': call['args'].get('reply_to'),
                'testTags': re.findall(r'ISSUE107_[A-Z0-9_]+', str(call['args'].get('text', '')))[:8]}
                for call in root.calls() if 'arlo_send_message' in call['name']][-8:], 'errors': [event for event in root.native() if event['type'] == 'driver-error']} for root in roots if isinstance(root, Peer)]
        report['claudePromptDiagnostics'] = [{'bytes': len(text.encode()), 'promptTags': re.findall(r'ISSUE105_USER_[0-9]{4}', text)[:4]}
            for root in roots if not isinstance(root, Peer) for text in claude_prompts(root) if text][-8:]
        print(json.dumps({'failed': report['error'], 'peerDiagnostics': report['peerDiagnostics'],
                          'claudePromptDiagnostics': report['claudePromptDiagnostics']}), flush=True)
    finally:
        report['modelPrompts'] = prompts
        report['observedModels'] = {}
        for root in roots:
            models = []
            if not isinstance(root, Peer):
                models = [row.get('message', {}).get('model') for row in root.transcript_rows()]
            else:
                for row in root.native():
                    message = row.get('message', {}) if row['type'] == 'message' else row.get('event', {}).get('data', {}).get('message', {})
                    if message.get('role') == 'assistant':
                        models.append(message.get('model') or message.get('source', {}).get('model'))
            report['observedModels'][root.directory.name] = sorted({model for model in models if isinstance(model, str) and re.fullmatch(r'[A-Za-z0-9._:/-]{1,200}', model)})
        for root in roots:
            if owns_run(run, owner):
                try:
                    if root.directory.name == 'b' and root.process.poll() is None:
                        root.enter('/quit')
                    else:
                        atomic(root.directory / 'action.json', {'type': 'stop'})
                except Exception:
                    report['cleanupSubmissionError'] = 'ACCEPTANCE_NATIVE_QUIT_OBSERVATION_FAILED'
                    if root.process.poll() is None:
                        root.process.terminate()
        try:
            stop_runners(roots)
        except Exception:
            report['runnerCleanupError'] = 'ACCEPTANCE_RUNNER_STOP_FAILED'
            for root in roots:
                try:
                    root.terminal.close()
                except Exception:
                    pass
        if daemon:
            if daemon.poll() is None and owns_run(run, owner):
                atomic(run / 'daemon-stop.json', {'owner': owner})
            try:
                daemon.wait(timeout=15)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=5)
        if daemon_log:
            daemon_log.close()
        for force in [False, True]:
            for pid in owned_processes(run, owner):
                if owns_run(run, owner) and pid in owned_processes(run, owner):
                    try:
                        if os.name == 'nt':
                            from windows import terminate_owned
                            terminate_owned(run, owner, pid)
                        else:
                            os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            until = time.monotonic() + 3
            while owned_processes(run, owner) and time.monotonic() < until:
                time.sleep(.1)
        final_sources = source_inventory()
        report['sourceSeal'] = {'unchanged': sources == final_sources,
            'beforeSha256': hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest(),
            'afterSha256': hashlib.sha256(json.dumps(final_sources, sort_keys=True).encode()).hexdigest()}
        report['stoppedHosts'] = [read_json(root.directory / 'stopped.json', {}) for root in roots]
        report['cleanup'] = {'liveOwnedProcessCount': len(owned_processes(run, owner)),
            'rootRunnerExits': [root.process.returncode for root in roots], 'daemonExit': daemon.returncode if daemon else None,
            'daemonDiscoveryRemoved': not (run / 'state/discovery.json').exists()}
        cleanup_ok = ('cleanupSubmissionError' not in report and 'runnerCleanupError' not in report and report['sourceSeal']['unchanged'] and report['cleanup']['liveOwnedProcessCount'] == 0 and
                      report['cleanup']['daemonDiscoveryRemoved'] and daemon is not None and daemon.returncode == 0 and
                      len(roots) == 3 and all(root.process.returncode == 0 for root in roots) and
                      report['stoppedHosts'][0].get('productionModExactCopy') is True and
                      all(row.get('stopped') is True for row in report['stoppedHosts'][1:]))
        try:
            report['cleanup']['privateSecretsRemoved'] = remove_owned_secrets(run, owner)
        except Exception:
            report['cleanup']['privateSecretsRemoved'] = False
            report['cleanup']['error'] = 'ACCEPTANCE_PRIVATE_CLEANUP_FAILED'
        report['passed'] = report['passed'] and cleanup_ok and report['cleanup']['privateSecretsRemoved']
        report['allRuntimeGatesPassed'] = report['passed'] and args.scenario == 'all'
        if not cleanup_ok:
            report['cleanup']['error'] = 'ACCEPTANCE_SOURCE_OR_RESOURCE_CHECK_FAILED'
        report['finishedAt'] = datetime.now().astimezone().isoformat()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        atomic(args.report, report)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
