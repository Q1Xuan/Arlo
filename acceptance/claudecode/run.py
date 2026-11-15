"""Opt-in real-model acceptance. Uses native terminals and the production runner.

Run only with --allow-real-models after authorizing the local API configuration.
No credentials, prompt bodies or terminal captures enter the evidence report.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from terminal import Terminal

BASE = pathlib.Path(__file__).resolve().parent
REPO = BASE.parent.parent


def read_json(file, default=None):
    try:
        if os.name == 'nt':
            from windows import read_text
            return json.loads(read_text(file))
        return json.loads(file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def atomic(file, value):
    temp = file.with_suffix(file.suffix + '.tmp')
    temp.write_text(json.dumps(value))
    temp.replace(file)


def source_inventory():
    files = [file for folder in ['packages', 'acceptance/claudecode']
             for file in (REPO / folder).rglob('*') if file.is_file() and
             not any(part in ['node_modules', 'types', '__pycache__'] for part in file.relative_to(REPO).parts)]
    files.extend(REPO / name for name in ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                                          'tsconfig.json', 'tsconfig.pi.json', 'tsconfig.build.json']
                 if (REPO / name).is_file())
    return {str(file.relative_to(REPO)): sha(file) for file in sorted(set(files))}


def timestamp_ms(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (AttributeError, TypeError, ValueError):
        return 0


def arithmetic_task(tag):
    return (tag + ': What is 23 + 19? Please answer locally as ' + tag +
            '_REPLY: 42 and copy the entire correlation marker appended at the end of this input. '
            'Include its square brackets, literal arlo-correlation: prefix and actual UUID unchanged.')


def claude_editor(screen):
    """Claude's input box without whitespace; None until it is fully drawn."""
    lines = screen.splitlines()
    rule = lambda line: line.strip() != '' and set(line.strip()) == {'─'}
    for index in range(len(lines) - 1, 0, -1):
        if lines[index].startswith('❯') and rule(lines[index - 1]):
            box = [lines[index][1:]]
            for line in lines[index + 1:]:
                if rule(line):
                    return ''.join(''.join(box).split())
                box.append(line)
            return None
    return None


def owns_run(run, owner):
    marker = run / '.arlo-owner.json'
    value = read_json(marker, {})
    return (not run.is_symlink() and run.is_dir() and not marker.is_symlink() and marker.is_file() and
            value.get('owner') == owner and value.get('purpose') == 'issue105-real-acceptance')


def owned_processes(run, owner):
    if os.name == 'nt':
        from windows import owned_processes as windows_owned_processes
        return windows_owned_processes(run, owner)
    # Linux /proc is inspected privately; neither environment contents nor
    # command lines leave this function. The run's unguessable owner selects
    # descendants even when a host has moved them into another process group.
    result = []
    for directory in pathlib.Path('/proc').iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            environment = (directory / 'environ').read_bytes().split(b'\0')
            if (('ARLO_ACCEPTANCE_ROOT=' + str(run)).encode() not in environment or
                    ('ARLO_ACCEPTANCE_OWNER=' + owner).encode() not in environment):
                continue
            state = (directory / 'stat').read_text().rsplit(')', 1)[1].split()[0]
            if state != 'Z':
                result.append(int(directory.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return result


def remove_owned_secrets(run, owner):
    if not owns_run(run, owner):
        raise RuntimeError('Acceptance ownership unavailable during private resource cleanup')
    if owned_processes(run, owner):
        raise RuntimeError('Live acceptance process prevents private resource cleanup')
    entries = [run / 'state', run / 'daemon.stderr']
    for label in ['a', 'b', 'c']:
        directory = run / label
        if directory.is_symlink():
            raise RuntimeError('Replaced acceptance root directory prevents private resource cleanup')
        if directory.is_dir():
            # Retain only bounded witness metadata; all native host files,
            # configs, caches, work copies and terminal captures are ephemeral.
            entries.extend(entry for entry in directory.iterdir()
                           if entry.name not in ['events.jsonl', 'stopped.json'])
    for entry in entries:
        if not owns_run(run, owner):
            raise RuntimeError('Acceptance ownership changed during private resource cleanup')
        if entry.is_symlink() or not entry.is_dir():
            entry.unlink(missing_ok=True)
        else:
            shutil.rmtree(entry)
    return all(not entry.exists() and not entry.is_symlink() for entry in entries)


class Root:
    def __init__(self, run, label, node, env, worker='root.mjs'):
        self.directory = run / label
        self.sid = str(uuid.uuid4())
        for name in ['config', 'work']:
            # Windows children inherit the already-private root ACL. Python
            # 3.13's special 0700 handling would add a new OWNER RIGHTS grant.
            (self.directory / name).mkdir(parents=True, mode=0o777 if os.name == 'nt' else 0o700)
        settings = pathlib.Path(os.environ.get('ARLO_ACCEPTANCE_SETTINGS', str(pathlib.Path.home() / '.claude/settings.json')))
        shutil.copyfile(settings, self.directory / 'config/settings.json')
        os.chmod(self.directory / 'config/settings.json', 0o600)
        onboarding = {'hasCompletedOnboarding': True, 'theme': 'dark',
                      'projects': {(self.directory / 'work').as_posix(): {'hasTrustDialogAccepted': True}}}
        for file in [self.directory / 'config/.claude.json', self.directory / 'config.json']:
            atomic(file, onboarding)
        self.terminal = Terminal([node, str(BASE / worker)], cwd=REPO,
            env={**env, 'ARLO_ACCEPTANCE_LABEL': label, 'ARLO_ACCEPTANCE_SESSION_ID': self.sid})
        self.process = self.terminal.process
        # The Linux cross-host driver also uses this native PTY descriptor.
        if os.name != 'nt':
            self.master = self.terminal.master
        self.capture = bytearray()
        self.capture_base = 0
        self.cursor_query_tail = b''
        # Windows prompt entry observes Claude's editor. Parse its screen from
        # startup, before the bounded pending capture can overflow.
        if os.name == 'nt' and worker == 'root.mjs':
            self.screen_text()

    def pump(self):
        data = self.terminal.read()
        self.capture.extend(data)
        # Native TUI startup can query cursor position, including under ConPTY.
        queries = self.cursor_query_tail + data
        if self.process.poll() is None and b'\x1b[6n' in queries:
            self.write(b'\x1b[1;1R')
        self.cursor_query_tail = queries[-3:]
        if len(self.capture) > 1048576:
            excess = len(self.capture) - 1048576
            del self.capture[:excess]
            self.capture_base += excess

    def write(self, data):
        self.terminal.write(data)

    def capture_offset(self):
        self.pump()
        return self.capture_base + len(self.capture)

    def text(self, offset=0):
        self.pump()
        offset = max(0, offset - self.capture_base)
        text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', self.capture[offset:].decode(errors='replace'))
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

    def screen_text(self):
        self.pump()
        return self.terminal.screen_text()

    def check_input_deadline(self, deadline):
        if deadline is not None and time.monotonic() >= deadline:
            raise RuntimeError('ACCEPTANCE_INPUT_DEADLINE_EXCEEDED')

    def enter(self, text, *, paste=True, deadline=None):
        self.check_input_deadline(deadline)
        if os.name == 'nt' and paste and not text.startswith('/'):
            # Windows console reads hand Claude at most 1024 characters, and it
            # keeps only the last of several reads handled together. A busy host
            # can also split one write across reads, or fold Enter into input it
            # has not processed. Type short chunks, each after the editor shows
            # everything before it, and retype a draft that lost characters.
            for attempt in range(3):
                if self.type_draft(text, deadline):
                    break
                self.clear_draft(deadline)
            else:
                raise RuntimeError('ACCEPTANCE_CLAUDE_EDITOR_INPUT_UNOBSERVED')
        else:
            # Unix editors receive long model prompts as one literal paste.
            self.write(('\x1b[200~' + text + '\x1b[201~' if paste and not text.startswith('/') else text).encode())
        time.sleep(.4)
        self.check_input_deadline(deadline)
        self.write(b'\r')

    def draft(self, deadline=None):
        self.check_input_deadline(deadline)
        if self.process.poll() is not None:
            raise RuntimeError('ACCEPTANCE_CLAUDE_HOST_EXITED')
        return claude_editor(self.screen_text())

    def type_draft(self, text, deadline=None):
        for end in range(256, len(text) + 256, 256):
            self.check_input_deadline(deadline)
            self.write(text[end - 256:end].encode())
            expected = ''.join(text[:end].split())
            until = time.monotonic() + 60
            while (draft := self.draft(deadline)) != expected:
                # Claude only appends typed input; a draft that is no longer a
                # prefix of the expected text has lost characters.
                if time.monotonic() > until or draft is not None and not expected.startswith(draft):
                    return False
                time.sleep(.05)
        return True

    def clear_draft(self, deadline=None):
        quiet = None
        until = time.monotonic() + 120
        while time.monotonic() < until:
            draft = self.draft(deadline)
            if draft is None:
                raise RuntimeError('ACCEPTANCE_CLAUDE_EDITOR_UNAVAILABLE')
            if draft:
                # Ctrl+U erases one rendered line, and is a no-op once empty.
                self.write(b'\x15')
                quiet = None
                time.sleep(.5)
            elif quiet is None:
                quiet = time.monotonic()
            elif time.monotonic() - quiet > 2:
                return
            time.sleep(.05)
        raise RuntimeError('ACCEPTANCE_CLAUDE_EDITOR_NOT_CLEARED')

    def live(self):
        return read_json(self.directory / 'live.json', {})

    def events(self):
        file = self.directory / 'events.jsonl'
        if not file.exists():
            return []
        return [json.loads(line) for line in file.read_text().splitlines() if line]

    def transcript_rows(self):
        # Session-specific native files prevent clear/resume/branch history or
        # an internal agent's output from satisfying another root's evidence.
        session_id = self.live().get('sessionId')
        if not isinstance(session_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,200}', session_id):
            return []
        rows = []
        for file in (self.directory / 'config/projects').glob('*/' + session_id + '.jsonl'):
            for line in file.read_text().splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get('sessionId') == session_id and not row.get('isSidechain', False):
                    rows.append(row)
        return rows

    def assistant_texts(self, after_ms=0):
        texts = []
        for row in self.transcript_rows():
            if row.get('type') == 'assistant' and timestamp_ms(row.get('timestamp')) >= after_ms:
                texts.extend(part['text'] for part in row.get('message', {}).get('content', [])
                             if isinstance(part, dict) and part.get('type') == 'text')
        return texts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--allow-real-models', action='store_true', required=True)
    parser.add_argument('--issue', type=int, help='Issue attributed to this acceptance report; does not change scenario gates.')
    parser.add_argument('--node', default=os.environ.get('ARLO_ACCEPTANCE_NODE', 'node'))
    parser.add_argument('--scenario', choices=['startup', 'exchange', 'isolation', 'busy', 'recovery', 'lifecycle', 'native-lifecycle', 'allowance', 'all'], default='all')
    parser.add_argument('--timeout-seconds', type=int, default=1200)
    parser.add_argument('--model-turn-timeout-seconds', type=int,
                        help='Wait budget for model-dependent gates; does not change protocol or recovery bounds.')
    parser.add_argument('--report', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.model_turn_timeout_seconds is not None and args.model_turn_timeout_seconds <= 0:
        parser.error('--model-turn-timeout-seconds must be positive')
    os.umask(0o077)
    package = read_json(REPO / 'package.json')
    actual_node = subprocess.check_output([args.node, '--version'], text=True).strip()
    if actual_node != 'v' + package['engines']['node']:
        raise RuntimeError('Pinned Node version required')
    owner = str(uuid.uuid4())
    run = pathlib.Path(tempfile.mkdtemp(prefix='arlo-issue105-',
        dir=pathlib.Path.home() if os.name == 'nt' else None))
    atomic(run / '.arlo-owner.json', {'owner': owner, 'purpose': 'issue105-real-acceptance'})
    if os.name == 'nt':
        from windows import protect_run
        protect_run(run, owner, args.node)
    (run / 'state').mkdir(mode=0o777 if os.name == 'nt' else 0o700)
    env = {**os.environ, 'ARLO_ACCEPTANCE_ROOT': str(run), 'ARLO_ACCEPTANCE_OWNER': owner,
           'PATH': str(pathlib.Path(args.node).parent) + os.pathsep + os.environ['PATH'],
           'TERM': 'xterm-256color', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
           'DISABLE_TELEMETRY': '1', 'ANTHROPIC_MAX_RETRIES': '0'}
    sources = source_inventory()
    report = {'schemaVersion': 2, 'issue': args.issue if args.issue is not None else (104 if os.name == 'nt' else 105),
              'passed': False, 'allRuntimeGatesPassed': False,
              'scenario': args.scenario, 'platform': platform.system().lower(),
              'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
              'node': actual_node, 'pnpm': package['packageManager'],
              'claude': subprocess.check_output([os.environ.get('ARLO_ACCEPTANCE_CLAUDE', 'claude'), '--version'], text=True).strip(),
              'kernel': platform.version() if os.name == 'nt' else platform.release(),
              'terminal': 'Windows ConPTY 48x170' if os.name == 'nt' else 'Linux PTY 48x170', 'sources': sources,
              'effort': 'low', 'startedAt': datetime.now().astimezone().isoformat(),
              'budget': {'timeoutSeconds': args.timeout_seconds,
                         'modelTurnTimeoutSeconds': args.model_turn_timeout_seconds or 180, 'maxModelPrompts': 20}, 'checks': [], 'messages': []}
    if os.name == 'nt':
        from importlib.metadata import version
        from windows import filesystem
        report['filesystems'] = {'source': filesystem(REPO), 'privateState': filesystem(run)}
        report['acceptanceTools'] = {name: version(name) for name in ['pywinpty', 'psutil', 'pyte', 'wcwidth']}
        report['acceptanceTools']['python'] = platform.python_version()
    daemon_log = open(run / 'daemon.stderr', 'wb')
    daemon = subprocess.Popen([args.node, str(BASE / 'daemon.mjs')], cwd=REPO, env=env,
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=daemon_log)
    roots = []
    deadline = time.monotonic() + args.timeout_seconds
    prompts = 0

    def pump():
        for root in roots:
            root.pump()

    def wait(predicate, timeout=180, failure='Acceptance condition timed out'):
        until = min(deadline, time.monotonic() + timeout)
        while time.monotonic() < until:
            pump()
            value = predicate()
            if value:
                return value
            time.sleep(.1)
        raise RuntimeError(failure)

    def model_wait(predicate, timeout=180, failure='Model-dependent acceptance condition timed out'):
        return wait(predicate, timeout=timeout if args.model_turn_timeout_seconds is None else
                    args.model_turn_timeout_seconds, failure=failure)

    def check(name, value):
        report['checks'].append({'name': name, 'passed': bool(value)})
        print(json.dumps({'check': name, 'passed': bool(value)}), flush=True)
        if not value:
            raise RuntimeError(name)

    def command(root, text, expected=None):
        root.pump()
        event_offset = len(root.events())
        time.sleep(.8)
        root.enter(text, deadline=deadline)
        if expected:
            def command_result():
                event = next((event for event in root.events()[event_offset:] if event['type'] == 'command.result' and
                    event.get('command') == text.split()[0].lstrip('/') and event.get('originKind') == 'composer' and
                    event.get('commandArgumentsEmpty') is True and event.get('outputObserved') is True), None)
                if not event:
                    return None
                rendered = {key + ':' + str(event[field]) for key, field in
                    [('Mode', 'mode'), ('Remaining', 'remaining'), ('Nextgrant', 'nextGrant'), ('Pausereason', 'pauseReason')]
                    if field in event}
                if event.get('authorizationSucceeded'):
                    rendered.add('用户已授权绑定')
                if event.get('authorizationCode'):
                    rendered.add(event['authorizationCode'])
                return event if expected in rendered else None
            try:
                # A TUI redraw may repeat old command output, and "1" is a
                # prefix of "14". Require the fresh engine-observed command
                # result and compare each complete field instead.
                result = wait(command_result, timeout=25,
                              failure='Native command expected result missing: ' + text.split()[0])
                report.setdefault('commands', []).append({'command': text.split()[0], 'passed': True,
                    'evidence': result})
            except RuntimeError:
                report.setdefault('commands', []).append({'command': text.split()[0], 'passed': False,
                    'observedResults': [event for event in root.events()[event_offset:] if event['type'] == 'command.result']})
                raise
        else:
            time.sleep(1)
            pump()

    def prompt(root, text):
        nonlocal prompts
        prompts += 1
        if prompts > 20:
            raise RuntimeError('Model prompt budget exhausted')
        tag = 'ISSUE105_USER_' + str(prompts).zfill(4)
        root.enter(tag + ': ' + text, deadline=deadline)
        return tag

    def completed(root, tag):
        starts = [event for event in root.events() if event['type'] == 'turn.start' and
                  tag in event.get('userPromptTags', [])]
        return len(starts) == 1 and any(event['type'] == 'turn.complete' and not event.get('agentId') and
                                       event.get('turnId') == starts[0]['turnId'] for event in root.events())

    def endpoints():
        return read_json(run / 'daemon.json', {}).get('endpoints', [])

    def endpoint(root):
        return next((e for e in endpoints() if e['sessionId'] == root.live().get('sessionId') and e['status'] == 'registered' and e['ready']), None)

    def ledger():
        return read_json(run / 'state/user-authorized-roots.json', {})

    def received(root, tag):
        sid = root.live().get('sessionId')
        file = run / 'state' / str(sid) / 'queue.jsonl'
        if not file.exists():
            return None
        matches = []
        for line in file.read_text().splitlines():
            row = json.loads(line)
            if re.match(r'^' + re.escape(tag) + r':(?:\s|$)', row.get('text', '')):
                matches.append(row)
        if len(matches) > 1:
            raise RuntimeError(tag + ': more than one real queue record matched the exact tag')
        return matches[0] if matches else None

    def verify_message(sender, receiver, tag, reply=False, credit='released'):
        record = model_wait(lambda: received(receiver, tag), failure='Real model did not deliver ' + tag)
        wait(lambda: received(receiver, tag)['status'] == 'claimed', timeout=180, failure='Host claim missing for ' + tag)
        events = receiver.events()
        claim_turns = [e for e in events if e['type'] == 'turn.start' and record['correlationId'] in e.get('markers', [])]
        check(tag + ':host-turn-marker', len(claim_turns) == 1)
        claimed_turn = claim_turns[0]
        retained = credit == 'retained'
        facts = wait(lambda: next((m for m in read_json(run / 'daemon.json', {}).get('messages', []) if m['messageId'] == record['messageId'] and m['holdsPendingCredit'] is retained), None), timeout=15, failure='Daemon pending credit did not match ' + credit)
        check(tag + ':daemon-credit-' + credit, facts['status'] == 'accepted' and
              read_json(run / 'daemon.json', {}).get('daemonId') == record['dispatch']['daemon_id'])
        check(tag + ':exact-dispatch-identity', facts['deliveryId'] == record['dispatch']['delivery_id'] and
              facts['toEndpoint'] == record['dispatch']['endpoint_id'] and
              facts['targetGeneration'] == record['dispatch']['generation'] and
              facts['nativeMessageId'] == record['nativeMessageId'] and
              facts['fromEndpoint'] == record.get('fromEndpoint'))
        native_calls = {}
        for row in sender.transcript_rows():
            if row.get('type') != 'assistant':
                continue
            for part in row.get('message', {}).get('content', []):
                if (isinstance(part, dict) and part.get('type') == 'tool_use' and
                        'arlo_send_message' in part.get('name', '') and
                        part.get('input', {}).get('to') == record['dispatch']['endpoint_id'] and
                        part.get('input', {}).get('text') == record['text']):
                    native_calls[part['id']] = part
        check(tag + ':exact-native-model-tool-call', len(native_calls) == 1)
        native_call = next(iter(native_calls.values()))
        tool = next((e for e in sender.events() if e['type'] == 'tool.start' and not e.get('agentId') and
                     e.get('toolUseId') == native_call['id'] and 'arlo_send_message' in e.get('tool', '') and
                     e.get('to') == record['dispatch']['endpoint_id']), None)
        check(tag + ':real-model-full-endpoint', tool is not None)
        def sender_result():
            for row in sender.transcript_rows():
                for block in row.get('message', {}).get('content', []):
                    if (not isinstance(block, dict) or block.get('type') != 'tool_result' or
                            block.get('tool_use_id') != native_call['id']):
                        continue
                    content = block.get('content', '')
                    text = content if isinstance(content, str) else '\n'.join(
                        item.get('text', '') for item in content if isinstance(item, dict) and item.get('type') == 'text')
                    try:
                        body = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    if body.get('message_id') == record['messageId'] and body.get('status') in ['accepted', 'rejected', 'unknown']:
                        return {'toolUseId': native_call['id'], 'messageId': body['message_id'], 'status': body['status']}
            return None
        returned = wait(sender_result, timeout=15, failure='Matching native sender tool result missing for ' + tag)
        check(tag + ':native-sender-tool-result', True)
        evidence = {'tag': tag, 'messageId': record['messageId'], 'dispatch': record['dispatch'],
                    'correlationId': record['correlationId'], 'status': received(receiver, tag)['status'],
                    'hostTurnId': claimed_turn['turnId'], 'modelToolUseId': tool['toolUseId'],
                    'replyAfterClaim': False, 'senderToolResult': returned, 'daemon': facts}
        evidence['observedModels'] = sorted({row['message']['model'] for root in [sender, receiver]
            for row in root.transcript_rows() if isinstance(row.get('message', {}).get('model'), str) and
            re.fullmatch(r'[A-Za-z0-9._:/-]{1,200}', row['message']['model'])})
        report['messages'].append(evidence)
        if reply:
            reply_pattern = re.compile(r'(?<![A-Za-z0-9_])' + re.escape(tag) +
                                       r'_REPLY\s*:\s*42(?![0-9A-Za-z_]|\.[0-9])')
            try:
                model_wait(lambda: any(reply_pattern.search(text) and '[arlo-correlation:' + record['correlationId'] + ']' in text
                                 for text in receiver.assistant_texts(claimed_turn['at'])),
                     failure='Separate model arithmetic reply and correlation marker missing for ' + tag)
            except RuntimeError:
                evidence['modelReplyDiagnostic'] = {
                    'assistantTextCountAfterClaim': len(receiver.assistant_texts(claimed_turn['at'])),
                    'claimedTurnCompleted': any(event['type'] == 'turn.complete' and
                        event.get('turnId') == claimed_turn['turnId'] for event in receiver.events()),
                    'queueStatus': received(receiver, tag)['status'],
                    'holdsPendingCredit': facts['holdsPendingCredit'],
                }
                raise
            check(tag + ':model-reply', True)
            evidence['replyAfterClaim'] = True
            model_wait(lambda: any(event['type'] == 'turn.complete' and not event.get('agentId') and
                event.get('turnId') == claimed_turn['turnId'] for event in receiver.events()),
                failure='Claimed reception turn did not finish for ' + tag)
        return record

    try:
        wait(lambda: read_json(run / 'daemon.json'), timeout=20, failure='Owned Daemon startup failed')
        roots.extend([Root(run, label, args.node, env) for label in ['a', 'b']])
        print(json.dumps({'run': str(run), 'phase': 'starting-two-real-roots'}), flush=True)
        for root in roots:
            # Real TUI first-run dialogs still require an Enter in some builds.
            start = time.monotonic()
            handled_prompts = set()
            while not root.live() and time.monotonic() - start < 100:
                pump()
                if root.process.poll() is not None:
                    raise RuntimeError('Native root runner exited during startup')
                text = root.screen_text() if os.name == 'nt' else root.text()
                trust_choices = re.findall(r'[❯>]\s*(No, exit|Yes, I trust this folder)', text)
                if (trust_choices and 'Yes, I trust this folder' in text and 'No, exit' in text and
                        'Enter to confirm' in text and 'Esc to cancel' in text and
                        'trust' not in handled_prompts):
                    # The Windows build initially selects "No, exit". This
                    # directory was created for this owned acceptance run;
                    # select its explicit Yes row instead of confirming No.
                    if trust_choices[-1] == 'No, exit':
                        changed_after = root.capture_offset()
                        root.write(b'\x1b[B')
                        wait(lambda: re.search(r'[❯>]\s*Yes, I trust this folder',
                             root.screen_text() if os.name == 'nt' else root.text(changed_after)),
                             timeout=5, failure='Native owned-workspace trust selection was not observed')
                    root.write(b'\r')
                    handled_prompts.add('trust')
                    report.setdefault('startupPrompts', []).append({'label': root.directory.name,
                        'prompt': 'owned-workspace-trust', 'selection': 'yes', 'selectionObserved': True})
                elif ('Choose the text style' in text or 'Let’s get started' in text) and 'onboarding' not in handled_prompts:
                    root.write(b'\r')
                    handled_prompts.add('onboarding')
                time.sleep(.3)
                if int(time.monotonic() - start) % 10 == 0:
                    print(json.dumps({'label': root.directory.name, 'startupSeconds': int(time.monotonic() - start),
                                      'processExit': root.process.poll()}), flush=True)
            wait(lambda: root.live().get('status') == 'active' and endpoint(root), timeout=30, failure='Real root Mod failed to attach')
        a, b = roots
        check('two-real-active-endpoints-one-daemon', endpoint(a)['endpointId'] != endpoint(b)['endpointId'])
        for root in roots:
            command(root, '/arlo-authorize', '用户已授权绑定')
        check('authorize-does-not-grant', all(row['period'] is None and row['used'] == 0 for row in ledger()['rows']))
        for root in roots:
            command(root, '/arlo-continue', 'Remaining:20')
        check('explicit-continue-first-period', len(ledger()['rows']) == 2 and all(row['sequence'] == 1 for row in ledger()['rows']))
        def send_request(destination, tag):
            return ('Use arlo_send_message exactly once with to=' + json.dumps(destination) +
                    ' and text=' + json.dumps(arithmetic_task(tag)) + '. Stop after the actual tool result; do not resend.')

        if args.scenario in ['exchange', 'all']:
            before = prompt(a, send_request(endpoint(b)['endpointId'], 'ISSUE105_A_TO_B'))
            verify_message(a, b, 'ISSUE105_A_TO_B', reply=True)
            model_wait(lambda: completed(a, before))
            before = prompt(b, send_request(endpoint(a)['endpointId'], 'ISSUE105_B_TO_A'))
            verify_message(b, a, 'ISSUE105_B_TO_A', reply=True)
            model_wait(lambda: completed(b, before))
            check('bidirectional-real-model-exchange', True)
        context = {'a': a, 'b': b, 'wait': wait, 'model_wait': model_wait, 'check': check, 'prompt': prompt, 'completed': completed,
                   'endpoint': endpoint, 'ledger': ledger, 'command': command, 'report': report,
                   'run': run, 'verify_message': verify_message, 'received': received, 'send_request': send_request}
        if args.scenario == 'native-lifecycle':
            context['interruptSenderAfterAcceptance'] = True
            context['cancel'] = lambda root: root.write(b'\x1b')
        if args.scenario in ['isolation', 'all']:
            from isolation import verify_isolation
            verify_isolation(context)
        if args.scenario in ['busy', 'lifecycle', 'all']:
            # Busy native tool is observed before sending; no synthetic prompt submits.
            busy_offset = len(b.events())
            before = prompt(b, 'For the IPC acceptance busy-work check, use Bash to execute exactly sleep 90, '
                'timeout 120000 and run_in_background=false. After it finishes report that the timer finished.')
            model_wait(lambda: any(e['type'] == 'tool.start' and e.get('busyWork') for e in b.events()[busy_offset:]), failure='Real foreground busy tool was not executed')
            send_before = prompt(a, send_request(endpoint(b)['endpointId'], 'ISSUE105_BUSY'))
            queued_busy = wait(lambda: received(b, 'ISSUE105_BUSY'), timeout=75, failure='Message missed busy work window')
            check('busy-message-queued-during-tool', queued_busy['status'] == 'enqueued' and
                  not any(e['type'] == 'tool.end' and e.get('busyWork') for e in b.events()[busy_offset:]))
            busy_tool = next(e for e in b.events()[busy_offset:] if e['type'] == 'tool.start' and e.get('busyWork'))
            tool_end = wait(lambda: next((e for e in b.events()[busy_offset:] if e['type'] == 'tool.end' and
                            e.get('toolUseId') == busy_tool['toolUseId'] and e.get('busyWork')), None), timeout=120,
                            failure='Foreground busy tool did not finish')
            report['busy'] = {'toolUseId': busy_tool['toolUseId'], 'toolStartedAt': busy_tool['at'],
                              'toolEndedAt': tool_end['at'], 'postToolTurnBudgetSeconds': args.model_turn_timeout_seconds or 180}
            model_wait(lambda: completed(b, before),
                 failure='Busy root model turn did not complete after foreground tool')
            record = verify_message(a, b, 'ISSUE105_BUSY', reply=True)
            claim_turn = next(e for e in b.events() if e['type'] == 'turn.start' and record['correlationId'] in e.get('markers', []))
            check('busy-tool-not-preempted', tool_end['at'] < claim_turn['at'])
            model_wait(lambda: completed(a, send_before) and completed(b, before))
            busy_start = next(e for e in b.events() if e['type'] == 'turn.start' and before in e.get('userPromptTags', []))
            busy_complete = next(e for e in b.events() if e['type'] == 'turn.complete' and e.get('turnId') == busy_start['turnId'])
            check('busy-root-turn-completes-before-reception', busy_complete['at'] < claim_turn['at'] and
                  busy_complete.get('reason') == 'answer')
            report['busy'].update(rootTurnId=busy_start['turnId'], rootTurnCompletedAt=busy_complete['at'],
                                  receptionTurnStartedAt=claim_turn['at'])
        if args.scenario in ['recovery', 'lifecycle', 'all']:
            from recovery import verify_recovery
            verify_recovery(context)
        if args.scenario in ['allowance', 'all']:
            from allowance import verify_allowance
            verify_allowance(context)
        if args.scenario == 'native-lifecycle':
            from recovery import verify_unknown_handoff
            verify_unknown_handoff(context)
        if args.scenario in ['lifecycle', 'native-lifecycle', 'all']:
            from lifecycle import verify_lifecycle
            verify_lifecycle(context)
        report['passed'] = not report.get('remainingGates')
        report['allRuntimeGatesPassed'] = report['passed'] and args.scenario == 'all'
    except Exception as error:
        report['failure'] = str(error)
        print(json.dumps({'failure': str(error), 'run': str(run)}), flush=True)
        report['nativeFailureDiagnostics'] = []
        for root in roots:
            rows = root.transcript_rows()
            assistant = [row for row in rows if row.get('type') == 'assistant']
            latest = next((event for event in reversed(root.events()) if event['type'] == 'turn.start'), {})
            latest_assistant = [row for row in assistant if timestamp_ms(row.get('timestamp')) >= latest.get('at', 0)]
            report['nativeFailureDiagnostics'].append({'label': root.directory.name,
                'startupFailure': read_json(root.directory / 'failure.json'),
                'processes': read_json(root.directory / 'processes.json', []),
                'sessionId': root.live().get('sessionId'),
                'bridgeStatus': root.live().get('status'), 'generation': root.live().get('generation'),
                'latestTurnId': latest.get('turnId'), 'latestUserPromptTags': latest.get('userPromptTags', []),
                'latestTurnAssistantRows': len(latest_assistant),
                'latestTurnCompleted': any(event['type'] == 'turn.complete' and
                    event.get('turnId') == latest.get('turnId') for event in root.events()),
                'userRows': sum(row.get('type') == 'user' for row in rows), 'assistantRows': len(assistant),
                'toolUseCount': sum(isinstance(block, dict) and block.get('type') == 'tool_use'
                    for row in assistant for block in row.get('message', {}).get('content', [])),
                'rootTurnStarts': sum(event['type'] == 'turn.start' for event in root.events()),
                'rootTurnCompletions': sum(event['type'] == 'turn.complete' and not event.get('agentId') for event in root.events()),
                'witnessErrors': [event for event in root.events() if event['type'] == 'witness.error'][-8:],
                'observerHttpRefused': root.text().count('ARLO_ACCEPTANCE_OBSERVER_HTTP_REFUSED'),
                'observerHttpUnavailable': root.text().count('ARLO_ACCEPTANCE_OBSERVER_HTTP_UNAVAILABLE')})
        # Private, ephemeral terminal captures support diagnosing native dialogs.
        # They are never copied into the public evidence report or repository.
        for root in roots:
            (root.directory / 'terminal.private').write_bytes(root.capture)
    finally:
        report['modelPrompts'] = prompts
        cleanup_errors = []
        ownership = owns_run(run, owner)
        if ownership:
            for root in roots:
                atomic(root.directory / 'action.json', {'type': 'stop'})
        else:
            cleanup_errors.append('ACCEPTANCE_CLEANUP_OWNERSHIP_UNAVAILABLE')
        # Drain every terminal while waiting: either platform's child can be
        # blocked writing its final screen while the other root is stopping.
        for phase, seconds in [('graceful', 15), ('terminate', 10), ('kill', 5)]:
            if phase != 'graceful':
                for root in roots:
                    if root.process.poll() is None:
                        if phase == 'kill' and os.name != 'nt' and ownership and owns_run(run, owner):
                            os.killpg(root.process.pid, signal.SIGKILL)
                        else:
                            root.process.terminate()
            until = time.monotonic() + seconds
            while any(root.process.poll() is None for root in roots) and time.monotonic() < until:
                pump()
                time.sleep(.05)
        for root in roots:
            root.pump()
            try:
                root.terminal.close()
            except Exception:
                cleanup_errors.append('ACCEPTANCE_TERMINAL_CLEANUP_FAILED')
        if daemon.poll() is None:
            if ownership and owns_run(run, owner):
                atomic(run / 'daemon-stop.json', {'owner': owner})
            else:
                daemon.terminate()
        try:
            daemon.wait(timeout=15)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait(timeout=5)
        daemon_log.close()
        if ownership:
            for pid in owned_processes(run, owner):
                # Recheck the run marker and the process environment before
                # signalling a descendant, rather than trusting a saved PID.
                if owns_run(run, owner) and pid in owned_processes(run, owner):
                    try:
                        if os.name == 'nt':
                            from windows import terminate_owned
                            terminate_owned(run, owner, pid)
                        else:
                            os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            until = time.monotonic() + 5
            while owned_processes(run, owner) and time.monotonic() < until:
                time.sleep(.1)
            for pid in owned_processes(run, owner):
                if owns_run(run, owner) and pid in owned_processes(run, owner):
                    try:
                        if os.name == 'nt':
                            from windows import terminate_owned
                            terminate_owned(run, owner, pid)
                        else:
                            os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            until = time.monotonic() + 5
            while owned_processes(run, owner) and time.monotonic() < until:
                time.sleep(.1)
        lingering = owned_processes(run, owner)
        roots_stopped = [read_json(root.directory / 'stopped.json', {}) for root in roots]
        cleanup = {'ownershipVerified': ownership, 'rootRunnerExits': [root.process.returncode for root in roots],
                   'daemonExit': daemon.returncode, 'rootStoppedReports': roots_stopped,
                   'liveOwnedProcessCount': len(lingering),
                   'daemonDiscoveryRemoved': not (run / 'state/discovery.json').exists()}
        cleanup_valid = (ownership and not lingering and cleanup['daemonDiscoveryRemoved'] and daemon.returncode == 0 and
                         all(root.process.returncode == 0 for root in roots) and
                         all('hostExit' in value and 'sidecarExit' in value and
                             value.get('productionModExactCopy') is True for value in roots_stopped))
        if not cleanup_valid:
            cleanup_errors.append('ACCEPTANCE_PROCESSES_OR_DAEMON_RESOURCES_NOT_RELEASED')
        report['checks'].append({'name': 'owned-processes-and-daemon-resources-released', 'passed': cleanup_valid})
        final_sources = source_inventory()
        source_unchanged = final_sources == sources
        report['sourceSeal'] = {'algorithm': 'sha256', 'unchanged': source_unchanged,
                                'beforeSha256': hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest(),
                                'afterSha256': hashlib.sha256(json.dumps(final_sources, sort_keys=True).encode()).hexdigest()}
        report['checks'].append({'name': 'runtime-sources-and-lock-unchanged-during-run', 'passed': source_unchanged})
        if not source_unchanged:
            cleanup_errors.append('ACCEPTANCE_RUNTIME_SOURCE_CHANGED_DURING_RUN')
        report['cleanup'] = cleanup
        report['finishedAt'] = datetime.now().astimezone().isoformat()
        private_files = [run / 'state/user-authorized-roots.json', run / 'state/autonomous-communication.json']
        private_files.extend((run / 'state').glob('*/queue.jsonl'))
        private_hashes = sorted(sha(file) for file in private_files if file.is_file() and not file.is_symlink())
        report['privateEvidenceSeal'] = {'algorithm': 'sha256', 'fileCount': len(private_hashes),
                                        'aggregateSha256': hashlib.sha256(json.dumps(private_hashes).encode()).hexdigest(),
                                        'scope': 'Final sending ledger, rules, and durable reception queues; content and credentials omitted.'}
        if cleanup_errors:
            report['passed'] = False
            report['allRuntimeGatesPassed'] = False
            report['cleanup']['errors'] = cleanup_errors
        # Write the selected metadata before deleting ephemeral credentials,
        # message bodies, transcript files and daemon private authority state.
        args.report.parent.mkdir(parents=True, exist_ok=True)
        atomic(args.report, report)
        try:
            cleanup['privateSecretsRemoved'] = remove_owned_secrets(run, owner)
        except Exception:
            cleanup['privateSecretsRemoved'] = False
            cleanup.setdefault('errors', []).append('ACCEPTANCE_PRIVATE_SECRET_CLEANUP_FAILED')
        report['checks'].append({'name': 'owned-private-credentials-and-transcripts-removed',
                                 'passed': cleanup['privateSecretsRemoved']})
        if not cleanup['privateSecretsRemoved']:
            report['passed'] = False
            report['allRuntimeGatesPassed'] = False
        atomic(args.report, report)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
