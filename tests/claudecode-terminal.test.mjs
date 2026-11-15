import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const python = process.env.ARLO_ACCEPTANCE_PYTHON ?? (process.platform === 'linux' ? 'python3' : undefined);
const options = { skip: python ? false : 'Opt-in acceptance Python runtime is not configured' };
const screenOptions = {
  skip: options.skip || (!process.env.ARLO_ACCEPTANCE_PYTHON && spawnSync(python,
    ['-B', '-c', 'import pyte'], { timeout: 15000 }).status !== 0
    ? 'Optional native screen parser is not installed; configure ARLO_ACCEPTANCE_PYTHON' : false),
};

test('real recovery entry requires explicit model authorization before launching a host', options, () => {
  const result = spawnSync(python, ['-B', 'acceptance/claudecode/run.py', '--scenario', 'recovery', '--report', 'unused.json'],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--allow-real-models/);
});

test('native acceptance model wait permits a slow response without extending protocol or scenario deadlines', options, () => {
  const script = String.raw`
import ast, pathlib, types
source = pathlib.Path('acceptance/claudecode/run.py').read_text()
main = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
functions = [node for node in main.body if isinstance(node, ast.FunctionDef) and node.name in ['wait', 'model_wait']]
clock = [0.0]
def sleep(seconds):
    clock[0] += seconds
time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=sleep)
pumps = []
scope = {'time': time, 'args': types.SimpleNamespace(model_turn_timeout_seconds=.5),
         'deadline': time.monotonic() + 2, 'pump': lambda: pumps.append(time.monotonic())}
exec(compile(ast.Module(body=functions, type_ignores=[]), '<actual acceptance waiters>', 'exec'), scope)
started = time.monotonic()
assert scope['model_wait'](lambda: time.monotonic() - started >= .2, timeout=.05)
assert len(pumps) >= 3
def must_expire(waiter, **kwargs):
    started = time.monotonic()
    try:
        waiter(lambda: False, **kwargs)
    except RuntimeError as error:
        assert str(error) == 'bounded-test'
    else:
        raise AssertionError('Acceptance deadline was bypassed')
    assert time.monotonic() - started < .4
scope['deadline'] = time.monotonic() + 2
must_expire(scope['wait'], timeout=.05, failure='bounded-test')
scope['deadline'] = time.monotonic() + .05
must_expire(scope['model_wait'], failure='bounded-test')
scope['args'].model_turn_timeout_seconds = None
scope['deadline'] = time.monotonic() + 2
must_expire(scope['model_wait'], timeout=.05, failure='bounded-test')
`;
  const result = spawnSync(python, ['-B', '-c', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('native acceptance terminal preserves interactive stdio, arguments and input until child exit', options, () => {
  const script = String.raw`
import json, os, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from terminal import Terminal
source = '''
console.log(JSON.stringify({input:process.stdin.isTTY,output:process.stdout.isTTY,args:process.argv.slice(1)}));
process.stdin.once('data', data => { console.log('RECEIVED:' + data.toString().trim()); process.exit(0); });
'''
terminal = Terminal([sys.argv[1], '-e', source, 'a path with spaces', 'literal & value'],
                    cwd=os.getcwd(), env=dict(os.environ))
try:
    output = bytearray()
    end = time.monotonic() + 15
    while b'"input":true' not in output and time.monotonic() < end:
        output.extend(terminal.read())
        time.sleep(.02)
    assert b'"input":true,"output":true' in output, bytes(output)
    assert b'"args":["a path with spaces","literal & value"]' in output, bytes(output)
    terminal.write(b'native-input\r')
    while b'RECEIVED:native-input' not in output and time.monotonic() < end:
        output.extend(terminal.read())
        time.sleep(.02)
    assert b'RECEIVED:native-input' in output, bytes(output)
    assert terminal.process.wait(timeout=5) == 0
finally:
    if terminal.process.poll() is None:
        terminal.process.kill()
        terminal.process.wait(timeout=5)
    terminal.close()
`;
  const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
});

test('model prompts reach a busy native editor completely before submission beyond 1024 bytes', options, () => {
  const script = String.raw`
import hashlib, os, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from run import Root
from terminal import Terminal
source = r'''
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
// Like Claude's editor: a bracketed paste applies at once, a busy host applies
// typed input and Ctrl+U later, and Enter submits the drawn draft. Once, the
// second typed read loses its first character, as under a busy Windows console.
let draft = '', paste = null, literal = false, buffer = '', reads = 0, clears = 0;
const rule = '─'.repeat(60);
const draw = () => process.stdout.write('\x1b[2J\x1b[H' + rule + '\r\n❯ ' + draft + '\r\n' + rule + '\r\n');
const later = edit => setTimeout(() => { edit(); draw(); }, 600);
const consume = text => {
  if (paste !== null) { paste += text; return; }
  for (const part of text.split(/(\x15)/)) {
    if (part === '\x15') later(() => { if (draft) clears++; draft = ''; });
    else if (part) { const kept = ++reads === 2 ? part.slice(1) : part; later(() => { draft += kept; }); }
  }
};
process.stdout.write('\x1b[?2004h');
draw();
process.stdin.on('data', data => {
  buffer += data;
  let match;
  while ((match = /\x1b\[20[01]~|\r/.exec(buffer))) {
    consume(buffer.slice(0, match.index));
    buffer = buffer.slice(match.index + match[0].length);
    if (match[0] === '\x1b[200~') paste = '';
    else if (match[0] === '\x1b[201~') { draft += paste; paste = null; literal = true; draw(); }
    else {
      console.log('SUBMITTED:' + JSON.stringify({literal, clears, sha256: require('node:crypto').createHash('sha256').update(draft).digest('hex')}));
      process.exit(0);
    }
  }
  // Keep a delimiter split across reads for the next read.
  const partial = /\x1b(\[(2(0[01]?)?)?)?$/.exec(buffer);
  consume(partial ? buffer.slice(0, partial.index) : buffer);
  buffer = partial ? buffer.slice(partial.index) : '';
});
'''
root = object.__new__(Root)
root.terminal = Terminal([sys.argv[1], '-e', source], cwd=os.getcwd(), env=dict(os.environ))
root.process, root.capture, root.capture_base, root.cursor_query_tail = root.terminal.process, bytearray(), 0, b''
try:
    end = time.monotonic() + 60
    while '❯' not in root.screen_text() and time.monotonic() < end:
        time.sleep(.02)
    text = 'ISSUE105_USER_0001: ' + ('literal JSON: {"text":"23 + 19?"} 中文 ' * 40)
    root.enter(text)
    while 'SUBMITTED:' not in root.screen_text() and time.monotonic() < end:
        time.sleep(.02)
    screen = ''.join(root.screen_text().split())
    submitted = screen[screen.find('SUBMITTED:'):]
    assert hashlib.sha256(text.encode()).hexdigest() in submitted, 'Native input was truncated or submitted early: ' + submitted
    # Unix PTYs deliver one literal paste; Windows retypes the damaged draft.
    expected = '"literal":false,"clears":1' if os.name == 'nt' else '"literal":true,"clears":0'
    assert expected in submitted, submitted
    assert root.process.wait(timeout=5) == 0
finally:
    if root.process.poll() is None:
        root.process.kill()
        root.process.wait(timeout=5)
    root.terminal.close()
`;
  const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stderr);
});

test('native prompt entry cannot submit or keep waiting after its scenario budget expires', screenOptions, () => {
  const script = String.raw`
import os, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from run import Root
from terminal import Terminal
source = r'''
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const rule = '─'.repeat(60);
let draft = '';
const draw = () => process.stdout.write('\x1b[2J\x1b[H' + rule + '\r\n❯ ' + draft + '\r\n' + rule + '\r\n');
draw();
process.stdin.on('data', data => {
  if (data.includes('\r')) process.stdout.write('\r\nSUBMITTED\r\n');
  else setTimeout(() => { draft += data; draw(); }, 600);
});
'''
root = object.__new__(Root)
root.terminal = Terminal([sys.argv[1], '-e', source], cwd=os.getcwd(), env=dict(os.environ))
root.process, root.capture, root.capture_base, root.cursor_query_tail = root.terminal.process, bytearray(), 0, b''
try:
    ready = time.monotonic() + 15
    while '❯' not in root.screen_text() and time.monotonic() < ready:
        time.sleep(.02)
    assert '❯' in root.screen_text()
    started = time.monotonic()
    try:
        root.enter('ISSUE105_USER_0001: ' + 'literal input ' * 50, deadline=started + .15)
    except RuntimeError as error:
        assert str(error) == 'ACCEPTANCE_INPUT_DEADLINE_EXCEEDED', str(error)
    else:
        raise AssertionError('Model prompt submitted after the scenario deadline')
    assert time.monotonic() - started < 2, 'Prompt entry ignored the absolute scenario budget'
    time.sleep(.8)
    assert 'SUBMITTED' not in root.screen_text(), 'Expired prompt reached native submission'
finally:
    if root.process.poll() is None:
        root.process.kill()
        root.process.wait(timeout=5)
    root.terminal.close()
`;
  const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
});

test('native acceptance terminal observes the currently selected trust row after incremental cursor redraw', screenOptions, () => {
  const script = String.raw`
import os, pathlib, re, sys, time
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from terminal import Terminal
source = r'''
process.stdin.setRawMode(true);
const initial = Buffer.from('\x1b[2J\x1b[HOwned workspace trust\r\n❯ No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm · Esc to cancel\r\n');
const marker = initial.indexOf(Buffer.from('❯'));
// Unix exposes output bytes; pywinpty exposes decoded ConPTY text.
const split = marker + (process.platform === 'win32' ? Buffer.byteLength('❯') : 1);
let stage = 0;
process.stdout.write(initial.subarray(0, split));
process.stdin.on('data', data => {
  if (stage++ === 0) process.stdout.write(initial.subarray(split));
  else if (stage === 2) process.stdout.write(process.platform === 'win32' ? '\x1b[6;1Hfragment-ready' : '\x1b[2;');
  else if (stage === 3) process.stdout.write((process.platform === 'win32' ? '\x1b[2;1H' : '1H') + ' \x1b[3;1H❯\x1b[6;1H\x1b[Kredraw-ready');
  else { process.stdout.write('\x1b[2J\x1b[HReady\r\n'); process.exit(0); }
});
'''
terminal = Terminal([sys.argv[1], '-e', source], cwd=os.getcwd(), env=dict(os.environ))
output = bytearray()
def observe(marker):
    end = time.monotonic() + 5
    while marker not in output and time.monotonic() < end:
        output.extend(terminal.read())
        time.sleep(.01)
    assert marker in output, 'Native replay output did not reach its next chunk'
def observe_screen(marker):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        output.extend(terminal.read())
        if marker in terminal.screen_text():
            return
        time.sleep(.01)
    raise AssertionError('Native replay screen did not reach its next state')
try:
    # Replay separate reads, including split UTF-8 on byte-oriented Unix PTYs.
    if os.name == 'nt':
        observe_screen('Owned workspace trust')
    else:
        observe(b'\xe2')
    assert '\ufffd' not in terminal.screen_text(), 'Partial UTF-8 must await its continuation'
    terminal.write(b'a')
    observe_screen('Esc to cancel')
    selected = re.findall(r'[❯>]\s*(No, exit|Yes, I trust this folder)', terminal.screen_text())
    assert selected == ['No, exit'], selected
    terminal.write(b'\x1b[B')
    if os.name == 'nt':
        observe_screen('fragment-ready')
    else:
        observe(b'\x1b[2;')
    assert re.findall(r'[❯>]\s*(No, exit|Yes, I trust this folder)', terminal.screen_text()) == ['No, exit']
    terminal.write(b'b')
    observe_screen('redraw-ready')
    selected = re.findall(r'[❯>]\s*(No, exit|Yes, I trust this folder)', terminal.screen_text())
    assert selected == ['Yes, I trust this folder'], selected
    terminal.write(b'\r')
    observe_screen('Ready')
    assert terminal.process.wait(timeout=5) == 0
    assert 'trust this folder' not in terminal.screen_text(), 'Cleared screen must discard old trust selection'
finally:
    if terminal.process.poll() is None:
        terminal.process.kill()
        terminal.process.wait(timeout=5)
    terminal.close()
`;
  const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
});

test('Windows acceptance protects Python temporary state with the existing private-state policy',
  { skip: process.platform !== 'win32' ? 'Windows native ACL behavior' : options.skip }, () => {
    const script = String.raw`
import json, os, pathlib, shutil, subprocess, sys, tempfile, uuid
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from windows import protect_run
root = pathlib.Path(tempfile.mkdtemp(dir=os.environ['ARLO_TEST_ROOT']))
owner = str(uuid.uuid4())
(root / '.arlo-owner.json').write_text(json.dumps({'owner': owner, 'purpose': 'issue105-real-acceptance'}))
try:
    protect_run(root, owner, sys.argv[1])
    source = "import { verifyWindowsAcl } from '@arlo/sdk'; if (!verifyWindowsAcl(process.argv[1]).valid) process.exit(1)"
    result = subprocess.run([sys.argv[1], '--input-type=module', '-e', source, str(root)])
    assert result.returncode == 0
finally:
    shutil.rmtree(root)
`;
    const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
  });

test('native Daemon observer keeps sampling when a reader holds its snapshot open', options, () => {
  const script = String.raw`
import json, os, pathlib, shutil, subprocess, sys, tempfile, time, uuid
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from run import atomic, owned_processes, remove_owned_secrets
root = pathlib.Path(tempfile.mkdtemp(dir=os.environ['ARLO_TEST_ROOT']))
owner = str(uuid.uuid4())
atomic(root / '.arlo-owner.json', {'owner': owner, 'purpose': 'issue105-real-acceptance'})
if os.name == 'nt':
    from windows import protect_run
    protect_run(root, owner, sys.argv[1])
(root / 'state').mkdir(mode=0o777 if os.name == 'nt' else 0o700)
env = {**os.environ, 'ARLO_ACCEPTANCE_ROOT': str(root), 'ARLO_ACCEPTANCE_OWNER': owner}
log = open(root / 'daemon.stderr', 'wb')
child = subprocess.Popen([sys.argv[1], 'acceptance/claudecode/daemon.mjs'], env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
result = {}
try:
    snapshot = root / 'daemon.json'
    end = time.monotonic() + 30
    while not snapshot.exists() and child.poll() is None and time.monotonic() < end:
        time.sleep(.05)
    assert snapshot.exists(), 'Native observer did not start'
    before = json.loads(snapshot.read_text())['observedAt']
    # Python's Windows CRT reader denies replacement until the handle closes.
    # Hold the actual observer output, without changing its publication code.
    with snapshot.open('r') as held:
        end = time.monotonic() + 2
        while child.poll() is None and time.monotonic() < end:
            time.sleep(.05)
        result['aliveWithReader'] = child.poll() is None
    end = time.monotonic() + 5
    while (child.poll() is None and json.loads(snapshot.read_text())['observedAt'] == before
           and time.monotonic() < end):
        time.sleep(.05)
    result['samplingResumed'] = child.poll() is None and json.loads(snapshot.read_text())['observedAt'] != before
finally:
    if child.poll() is None:
        atomic(root / 'daemon-stop.json', {'owner': owner})
    try:
        child.wait(timeout=20)
    except subprocess.TimeoutExpired:
        child.terminate()
        child.wait(timeout=5)
    log.close()
    result.update(exit=child.returncode, discoveryRemoved=not (root / 'state/discovery.json').exists())
    end = time.monotonic() + 5
    while owned_processes(root, owner) and time.monotonic() < end:
        time.sleep(.05)
    print(json.dumps(result), flush=True)
    remove_owned_secrets(root, owner)
    shutil.rmtree(root)
assert result.get('aliveWithReader') and result.get('samplingResumed'), result
assert result['exit'] == 0 and result['discoveryRemoved'], result
`;
  const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 65000 });
  assert.equal(result.status, 0, result.stderr);
});

test('Windows metadata reads survive replacement contention and retain persistent access failures',
  { skip: process.platform !== 'win32' ? 'Windows native file-sharing behavior' : options.skip }, () => {
    const script = String.raw`
import ctypes, json, os, pathlib, shutil, sys, tempfile, threading, time, uuid
from ctypes import wintypes
sys.path.insert(0, str(pathlib.Path('acceptance/claudecode').resolve()))
from run import atomic, read_json
from windows import protect_run
root = pathlib.Path(tempfile.mkdtemp(dir=os.environ['ARLO_TEST_ROOT']))
owner = str(uuid.uuid4())
atomic(root / '.arlo-owner.json', {'owner': owner, 'purpose': 'issue105-real-acceptance'})
protect_run(root, owner, sys.argv[1])
file = root / 'live.json'
file.write_text(json.dumps({'generation': 7}))
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                              wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.GetCurrentProcess.restype = wintypes.HANDLE
kernel.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
def lock():
    handle = kernel.CreateFileW(str(file), 0x80000000, 0, None, 3, 0x80, None)
    assert handle != wintypes.HANDLE(-1).value
    return handle
def handles():
    count = wintypes.DWORD()
    assert kernel.GetProcessHandleCount(kernel.GetCurrentProcess(), ctypes.byref(count))
    return count.value
try:
    handle = lock()
    release = threading.Timer(.2, lambda: kernel.CloseHandle(handle))
    release.start()
    try:
        assert read_json(file, {}) == {'generation': 7}
    finally:
        release.join()
    handle = lock()
    start = time.monotonic()
    try:
        try:
            read_json(file, {})
        except PermissionError:
            assert time.monotonic() - start < 5, 'Persistent access failure exceeded its bound'
        else:
            raise AssertionError('Persistent access failure must not become an empty snapshot')
    finally:
        kernel.CloseHandle(handle)
    before = handles()
    for _ in range(16):
        assert read_json(file) == {'generation': 7}
    assert handles() == before, 'Native metadata reads leaked handles'
finally:
    shutil.rmtree(root)
`;
    const result = spawnSync(python, ['-B', '-c', script, process.execPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
  });
