"""Opt-in native Claude baseline without Arlo, plugins, Sidecars or a Daemon.

Only three ordinary arithmetic prompts are submitted. Native transcript data is
read inside the owned temporary configuration; only bounded facts leave it.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import uuid


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def atomic(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(file)


def transcript_rows(config):
    rows = []
    for file in (config / 'projects').glob('*/*.jsonl'):
        try:
            for line in file.read_text().splitlines():
                try:
                    row = json.loads(line)
                    if row.get('type') in ['user', 'assistant']:
                        rows.append(row)
                except json.JSONDecodeError:
                    continue
        except FileNotFoundError:
            continue
    return rows


def plain_text(row):
    content = row.get('message', {}).get('content', [])
    if isinstance(content, str):
        return content
    return ''.join(part.get('text', '') for part in content
                   if isinstance(part, dict) and part.get('type') == 'text')


def token_counts(row):
    usage = row.get('message', {}).get('usage', {})
    names = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    return {name: usage[name] for name in names if isinstance(usage.get(name), int) and usage[name] >= 0}


def owned_processes(run, owner):
    result = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            entries = (directory / 'environ').read_bytes().split(b'\0')
            if (('ARLO_BASELINE_RUN=' + str(run)).encode() in entries and
                    ('ARLO_BASELINE_OWNER=' + owner).encode() in entries and
                    (directory / 'stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z'):
                result.append(int(directory.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--allow-real-models', action='store_true', required=True)
    parser.add_argument('--claude', default=os.environ.get('ARLO_ACCEPTANCE_CLAUDE', 'claude'))
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    version = subprocess.check_output([args.claude, '--version'], text=True).strip()
    if version != '2.1.296 (Claude Code)':
        raise RuntimeError('Baseline requires Claude Code 2.1.296')
    run = Path(tempfile.mkdtemp(prefix='arlo-issue105-baseline-'))
    owner, session_id = str(uuid.uuid4()), str(uuid.uuid4())
    marker = run / '.baseline-owner.json'
    atomic(marker, {'owner': owner, 'purpose': 'issue105-native-baseline'})
    config, work = run / 'config', run / 'work'
    for folder in [config, work, run / 'xdg-config', run / 'xdg-cache', run / 'xdg-data']:
        folder.mkdir(mode=0o700)
    settings = Path(os.environ.get('ARLO_ACCEPTANCE_SETTINGS', str(Path.home() / '.claude/settings.json')))
    shutil.copyfile(settings, config / 'settings.json')
    os.chmod(config / 'settings.json', 0o600)
    onboarding = {'hasCompletedOnboarding': True, 'theme': 'dark',
                  'projects': {str(work): {'hasTrustDialogAccepted': True}}}
    for file in [config / '.claude.json', run / 'config.json']:
        atomic(file, onboarding)
    environment = {**os.environ, 'CLAUDE_CONFIG_DIR': str(config),
        'XDG_CONFIG_HOME': str(run / 'xdg-config'), 'XDG_CACHE_HOME': str(run / 'xdg-cache'),
        'XDG_DATA_HOME': str(run / 'xdg-data'), 'TERM': 'xterm-256color',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_TELEMETRY': '1',
        'ANTHROPIC_MAX_RETRIES': '0', 'ARLO_BASELINE_RUN': str(run), 'ARLO_BASELINE_OWNER': owner}
    # No HOME override or Arlo bridge/observer variables enter this process.
    environment = {key: value for key, value in environment.items()
                   if not key.startswith(('ARLO_CLAUDECODE_', 'ARLO_ACCEPTANCE_'))}
    argv = [args.claude, '--session-id', session_id, '--setting-sources', 'user',
            '--effort', 'low', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--permission-mode', 'dontAsk', '--tools', 'Read', '--allowedTools', 'Read']
    report = {'schemaVersion': 1, 'purpose': 'issue105-native-provider-baseline',
              'passed': False, 'claude': version, 'platform': 'linux', 'kernel': os.uname().release,
              'terminal': 'Linux PTY 48x170', 'sessionId': session_id, 'effort': 'low',
              'startedAt': timestamp(), 'modelPrompts': 0, 'maxPrompts': 3,
              'timeoutSecondsPerPrompt': 90, 'arloLoaded': False,
              'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'prompts': []}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 170, 0, 0))
    process = subprocess.Popen(argv, cwd=work, env=environment, stdin=slave, stdout=slave,
                               stderr=slave, start_new_session=True)
    os.close(slave)
    capture = bytearray()

    def pump():
        while select.select([master], [], [], 0)[0]:
            try:
                capture.extend(os.read(master, 65536))
                if len(capture) > 2097152:
                    del capture[:-2097152]
            except OSError:
                break

    def screen(offset=0):
        pump()
        text = capture[offset:].decode(errors='replace')
        text = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

    def enter(value):
        os.write(master, value.encode())
        time.sleep(.4)
        os.write(master, b'\r')

    try:
        startup = time.monotonic()
        ready = False
        last_confirmation = 0
        while time.monotonic() - startup < 45 and process.poll() is None:
            text = screen()
            if ('trust this folder' in text.lower() or 'Choose the text style' in text or
                    'Let’s get started' in text):
                if time.monotonic() - last_confirmation > 2:
                    os.write(master, b'\r')
                    last_confirmation = time.monotonic()
            elif any(phrase in text for phrase in ['for shortcuts', 'bypass permissions', 'Claude Code',
                                                   'Try "', '? for', '❯', '> ']):
                if time.monotonic() - startup >= 5:
                    ready = True
                    break
            time.sleep(.1)
        if not ready:
            report['failureCode'] = 'NATIVE_STARTUP_UNAVAILABLE'
            return 1
        report['readyAt'] = timestamp()
        print(json.dumps({'baseline': 'ready', 'claude': version}), flush=True)
        requests = ['What is 6 times 7?', 'What is 21 plus 21?', 'What is 84 divided by 2?']
        for index, request in enumerate(requests, start=1):
            before = {row.get('uuid') for row in transcript_rows(config)}
            offset = len(capture)
            started = time.monotonic()
            fact = {'index': index, 'promptAt': timestamp(), 'status': 'pending'}
            report['prompts'].append(fact)
            report['modelPrompts'] += 1
            print(json.dumps({'baselinePrompt': index, 'status': 'submitted', 'at': fact['promptAt']}), flush=True)
            enter(request)
            deadline = started + 90
            while time.monotonic() < deadline:
                pump()
                new_rows = [row for row in transcript_rows(config) if row.get('uuid') not in before]
                user = next((row for row in new_rows if row.get('type') == 'user' and request in plain_text(row)), None)
                if user and 'nativeInputAt' not in fact:
                    fact['nativeInputAt'] = user.get('timestamp')
                    fact['inputObservedAt'] = timestamp()
                answers = [row for row in new_rows if row.get('type') == 'assistant' and plain_text(row)]
                answer = next((row for row in answers if re.search(r'(?<!\d)42(?!\d)', plain_text(row))), None)
                if answer:
                    fact.update(status='answer', answerMatches42=True, answerAt=answer.get('timestamp'),
                                answerObservedAt=timestamp(), elapsedSeconds=round(time.monotonic() - started, 3),
                                tokens=token_counts(answer))
                    model = answer.get('message', {}).get('model')
                    if isinstance(model, str) and re.fullmatch(r'[A-Za-z0-9._:/-]{1,200}', model):
                        fact['model'] = model
                    break
                final = next((row for row in answers if row.get('message', {}).get('stop_reason') in
                              ['end_turn', 'stop_sequence', 'max_tokens']), None)
                if final:
                    fact.update(status='wrong-answer', answerMatches42=False, answerAt=final.get('timestamp'),
                                answerObservedAt=timestamp(), elapsedSeconds=round(time.monotonic() - started, 3),
                                tokens=token_counts(final))
                    break
                terminal = screen(offset).lower()
                if any(phrase in terminal for phrase in ['api error:', 'invalid api key', 'authentication failed',
                                                        'connection error', 'unable to connect']):
                    fact.update(status='provider-error', errorCode='NATIVE_PROVIDER_ERROR',
                                failureAt=timestamp(), elapsedSeconds=round(time.monotonic() - started, 3))
                    break
                if process.poll() is not None:
                    fact.update(status='host-exited', failureAt=timestamp(),
                                elapsedSeconds=round(time.monotonic() - started, 3))
                    break
                time.sleep(.1)
            if fact['status'] == 'pending':
                fact.update(status='timeout', failureAt=timestamp(),
                            elapsedSeconds=round(time.monotonic() - started, 3))
            print(json.dumps({'baselinePrompt': index, 'status': fact['status'],
                              'elapsedSeconds': fact['elapsedSeconds']}), flush=True)
            if fact['status'] != 'answer':
                # Never overlap another request with a response still running.
                break
            time.sleep(1)
            pump()
        report['passed'] = len(report['prompts']) == 3 and all(fact['status'] == 'answer' for fact in report['prompts'])
        return 0 if report['passed'] else 1
    finally:
        if process.poll() is None:
            enter('/exit')
            until = time.monotonic() + 8
            while process.poll() is None and time.monotonic() < until:
                pump()
                time.sleep(.1)
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        process.wait(timeout=5)
        for pid in owned_processes(run, owner):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        until = time.monotonic() + 5
        while owned_processes(run, owner) and time.monotonic() < until:
            time.sleep(.1)
        for pid in owned_processes(run, owner):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.close(master)
        capture.clear()
        leftover = owned_processes(run, owner)
        marker_data = json.loads(marker.read_text())
        cleanup_safe = not run.is_symlink() and marker_data.get('owner') == owner and not leftover
        if cleanup_safe:
            shutil.rmtree(run)
        report['finishedAt'] = timestamp()
        report['cleanup'] = {'nativeExit': process.returncode, 'ownedChildrenRemaining': len(leftover),
                             'privateConfigurationAndTranscriptsRemoved': cleanup_safe and not run.exists()}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        atomic(args.report, report)


if __name__ == '__main__':
    raise SystemExit(main())
