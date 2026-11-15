import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Exercise the evidence reader boundary with the documented public host event
// shapes. These fixtures are never used as real-host acceptance evidence.
const pythonRuntime = process.env.ARLO_ACCEPTANCE_PYTHON ?? (process.platform === 'linux' ? 'python3' : undefined);
const nativeOptions = { skip: pythonRuntime ? false : 'Opt-in acceptance Python runtime is not configured' };

test('cross-host evidence associates native DSH and Pi results with their own tool call', nativeOptions, () => {
  const python = String.raw`
import json, pathlib, sys, tempfile
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from cross_host import Peer
with tempfile.TemporaryDirectory() as root:
    for label in ['b', 'c']:
        peer = object.__new__(Peer)
        peer.directory = pathlib.Path(root) / label
        peer.directory.mkdir()
        if label == 'c':
            rows = [
                {'at': 1, 'type': 'native', 'event': {'type': 'tool/call', 'data': {
                    'callId': 'native-call', 'name': 'arlo_send_message', 'arguments': '{"to":"ep-target","text":"question"}'}}},
                {'at': 2, 'type': 'native', 'event': {'type': 'tool/result', 'data': {'message': {
                    'toolCallId': 'different-call', 'content': [{'type': 'text', 'text': 'wrong result'}]}}}},
                {'at': 3, 'type': 'native', 'event': {'type': 'tool/result', 'data': {'message': {
                    'toolCallId': 'native-call', 'content': [{'type': 'text', 'text': 'own result'}]}}}},
                {'at': 4, 'type': 'native', 'event': {'type': 'assistant/message', 'data': {'message': {
                    'content': [{'type': 'text', 'text': 'TAG_REPLY: 42'}]}}}},
            ]
        else:
            rows = [
                {'at': 1, 'type': 'call', 'id': 'native-call', 'name': 'arlo_send_message',
                 'args': {'to': 'ep-target', 'text': 'question'}},
                {'at': 2, 'type': 'result', 'id': 'different-call', 'result': {'content': [{'type': 'text', 'text': 'wrong result'}]}},
                {'at': 3, 'type': 'result', 'id': 'native-call', 'result': {'content': [{'type': 'text', 'text': 'own result'}]}},
                {'at': 4, 'type': 'message', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'TAG_REPLY: 42'}]}},
            ]
        file = peer.directory / 'native.private.jsonl'
        file.write_text(''.join(json.dumps(row) + '\n' for row in rows) + '{"partial":')
        assert peer.calls() == [{'id': 'native-call', 'name': 'arlo_send_message', 'args': {'to': 'ep-target', 'text': 'question'}}]
        assert peer.result('native-call') == 'own result'
        assert peer.result('missing-call') is None
        assert peer.assistant_texts(3) == ['TAG_REPLY: 42']
        assert peer.assistant_texts(5) == []
        assert peer.reception_complete('TAG') is False
        # Completion must follow this answer: another turn cannot settle it.
        if label == 'b':
            completion = {'at': 6, 'type': 'settled'}
        else:
            rows[-1]['event']['data']['turn'] = 7
            completion = {'at': 6, 'type': 'native', 'event': {'type': 'turn/end', 'data': {'turn': 7, 'reason': 'completed'}}}
        file.write_text(''.join(json.dumps(row) + '\n' for row in rows + [completion]))
        assert peer.reception_complete('TAG') is True
        with file.open('w') as output:
            output.write(json.dumps({'at': 5, 'type': 'native', 'event': {'type': 'turn/end', 'data': {'reason': 'completed'}}}) + '\n')
        assert peer.model_error() is None
        with file.open('w') as output:
            output.write(json.dumps({'at': 5, 'type': 'native', 'event': {'type': 'turn/end', 'data': {'reason': {'kind': 'error', 'error': {'code': 'UNSUPPORTED_REASONING_EFFORT', 'message': 'private provider detail'}}}}}) + '\n')
        assert peer.model_error() == 'UNSUPPORTED_REASONING_EFFORT'
`;
  const result = spawnSync(pythonRuntime, ['-B', '-c', python], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('three-host shutdown drains every native terminal before closing its resources', nativeOptions, () => {
  const python = String.raw`
import os, pathlib, sys, types
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from cross_host import stop_runners
from terminal import Terminal
roots = []
for delay in [0, .25, .5]:
    terminal = Terminal([sys.executable, '-c',
        'import os,time; time.sleep(' + str(delay) + '); os.write(1,b"x"*262144)'],
        cwd=os.getcwd(), env=dict(os.environ))
    roots.append(types.SimpleNamespace(terminal=terminal, process=terminal.process, pump=terminal.read))
try:
    stop_runners(roots)
    assert [root.process.returncode for root in roots] == [0, 0, 0]
    for root in roots:
        assert root.terminal.closed, 'Native terminal resource leaked'
finally:
    for root in roots:
        if root.process.poll() is None:
            root.process.kill()
            root.process.wait()
        root.terminal.close()
`;
  const result = spawnSync(pythonRuntime, ['-B', '-c', python], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
});

test('business-answer evidence requires the exact task tag and the correct arithmetic result', nativeOptions, () => {
  const python = String.raw`
import pathlib, sys
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from cross_host import reply_match
assert reply_match('TASK_A', 'TASK_A_REPLY: 42')
assert reply_match('TASK_A', 'Result: TASK_A_REPLY: 42. Finished.')
for wrong in ['TASK_A_REPLY: 41', 'TASK_A_REPLY: 42.5', 'TASK_A_REPLY: 420',
              'OTHER_TASK_A_REPLY: 42', 'TASK_B_REPLY: 42']:
    assert reply_match('TASK_A', wrong) is None
`;
  const result = spawnSync(pythonRuntime, ['-B', '-c', python], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Pi command status waits for its fresh native event despite a cached terminal redraw', nativeOptions, () => {
  const python = String.raw`
import ast, json, pathlib, re, sys, tempfile, threading, time
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from cross_host import Peer
source = pathlib.Path('acceptance/claudecode/cross_host.py').read_text()
main = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
command = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == 'command')
with tempfile.TemporaryDirectory() as directory:
    class ObservedPeer(Peer):
        def capture_offset(self):
            return 0
        def text(self, offset=0):
            return 'Arlo dispatch attempts\nPeriod: old-period\nUsed: 9\nRemaining: 11'
        def enter(self, text, **kwargs):
            def publish():
                with file.open('a') as output:
                    output.write(json.dumps({'at': 2, 'type': 'command', 'text':
                        'Arlo dispatch attempts\nPeriod: current-period\nUsed: 3\nRemaining: 17'}) + '\n')
            self.pending = threading.Timer(.3, publish)
            self.pending.start()
    peer = object.__new__(ObservedPeer)
    peer.directory = pathlib.Path(directory) / 'b'
    peer.directory.mkdir()
    file = peer.directory / 'native.private.jsonl'
    file.write_text(json.dumps({'at': 1, 'type': 'command', 'text': peer.text()}) + '\n')
    def wait(predicate, **kwargs):
        until = time.monotonic() + 2
        while time.monotonic() < until:
            result = predicate()
            if result:
                return result
            time.sleep(.01)
        raise AssertionError('Fresh native command result was not observed')
    scope = {'Peer': Peer, 'wait': wait, 're': re, 'deadline': time.monotonic() + 2}
    exec(compile(ast.Module(body=[command], type_ignores=[]), '<actual command evidence reader>', 'exec'), scope)
    try:
        result = scope['command'](peer, '/arlo-send-status', 'Arlodispatchattempts')
        assert result == {'Period': 'current-period', 'Used': '3', 'Remaining': '17'}, result
    finally:
        peer.pending.join()
`;
  const result = spawnSync(pythonRuntime, ['-B', '-c', python], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});
