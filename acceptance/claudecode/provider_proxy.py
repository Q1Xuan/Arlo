"""Opt-in local provider timing proxy for synthetic Arlo diagnosis only.

No request/response bodies, URLs, headers, credentials or terminal output are
written. Request and response bodies are forwarded byte-for-byte; bounded
metadata is updated live. --disable-thinking changes the private diagnostic
configuration before Claude runs; it does not rewrite requests in transit.
"""
import argparse
import ctypes
import gzip
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import zlib

HOP_HEADERS = {'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
               'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization'}
MAX_BODY = 16 * 1024 * 1024
MAX_REQUESTS = 128
TIMEOUT = 180
BASE = Path(__file__).resolve().parent
REPO = BASE.parent.parent


def atom(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(file)


def name(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:/-]{1,100}', value) else None


def integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10000000 else None


def config():
    file = Path(os.environ.get('ARLO_ACCEPTANCE_SETTINGS', str(Path.home() / '.claude/settings.json')))
    settings = json.loads(file.read_text())
    environment = {**settings.get('env', {}), **os.environ}
    upstream = urllib.parse.urlsplit(environment.get('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'))
    if (upstream.scheme not in ['https', 'http'] or not upstream.hostname or upstream.username or
            upstream.password or upstream.query or upstream.fragment):
        raise ValueError('PROXY_CONFIGURATION_INVALID')
    return settings, environment, upstream


class State:
    def __init__(self, file):
        self.file = file
        self.lock = threading.RLock()
        self.report = {'schemaVersion': 1, 'scope': 'real-Claude-provider-diagnosis-only',
                       'countsAsAcceptance': False, 'bodyForwarding': 'unchanged',
                       'maxTrackedRequests': MAX_REQUESTS, 'requestDeadlineSeconds': TIMEOUT,
                       'records': [], 'droppedRequestCount': 0}
        atom(file, self.report)

    def persist(self):
        with self.lock:
            try:
                atom(self.file, self.report)
            except OSError:
                # Observability must not interrupt the upstream response. Keep
                # a sticky, bounded failure verdict for the wrapper's exit.
                self.report['reportWriteFailed'] = True
                self.report['reportErrorCode'] = 'PROVIDER_REPORT_WRITE_FAILED'

    def start(self, value):
        with self.lock:
            if len(self.report['records']) >= MAX_REQUESTS:
                self.report['droppedRequestCount'] += 1
                self.persist()
                return None
            value['requestId'] = len(self.report['records']) + 1
            self.report['records'].append(value)
            self.persist()
            return value

    def update(self, record, **values):
        if record is None:
            return
        with self.lock:
            record.update(values)
            self.persist()


class BrotliDecoder:
    def __init__(self):
        self.library = ctypes.CDLL('libbrotlidec.so.1')
        self.library.BrotliDecoderCreateInstance.restype = ctypes.c_void_p
        self.library.BrotliDecoderDecompressStream.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)), ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)), ctypes.POINTER(ctypes.c_size_t)]
        self.library.BrotliDecoderDestroyInstance.argtypes = [ctypes.c_void_p]
        self.instance = self.library.BrotliDecoderCreateInstance(None, None, None)
        if not self.instance:
            raise ValueError()

    def decompress(self, value):
        source = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
        available_in = ctypes.c_size_t(len(value))
        next_in = ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte))
        pieces = []
        while True:
            output = (ctypes.c_ubyte * 65536)()
            available_out = ctypes.c_size_t(len(output))
            next_out = ctypes.cast(output, ctypes.POINTER(ctypes.c_ubyte))
            total = ctypes.c_size_t()
            result = self.library.BrotliDecoderDecompressStream(self.instance, ctypes.byref(available_in),
                ctypes.byref(next_in), ctypes.byref(available_out), ctypes.byref(next_out), ctypes.byref(total))
            pieces.append(bytes(output[:len(output) - available_out.value]))
            if result == 0:
                raise ValueError()
            if result in [1, 2]:
                break
        return b''.join(pieces)

    def __del__(self):
        if getattr(self, 'instance', None):
            self.library.BrotliDecoderDestroyInstance(self.instance)
            self.instance = None


class Witness:
    def __init__(self, state, record, started, encoding):
        self.state, self.record, self.started = state, record, started
        self.buffer = b''
        self.lines = []
        self.events = self.output = self.thinking = self.tools = 0
        self.first_event = self.first_content = None
        self.stopped = False
        self.enabled = encoding in ['', 'identity', 'gzip', 'deflate', 'br']
        self.decoder = None
        try:
            self.decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == 'gzip' else zlib.decompressobj() if encoding == 'deflate' else BrotliDecoder() if encoding == 'br' else None
        except Exception:
            self.enabled = False
            state.update(record, sseObservation='decoder-unavailable')
        if not self.enabled:
            if encoding not in ['', 'identity', 'gzip', 'deflate', 'br']:
                state.update(record, sseObservation='unsupported-content-encoding')

    def feed(self, part):
        if not self.enabled:
            return
        try:
            if self.decoder:
                part = self.decoder.decompress(part)
            self.buffer += part
            if len(self.buffer) > 1024 * 1024:
                self.enabled = False
                self.buffer = b''
                self.state.update(self.record, sseObservation='event-too-large')
                return
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                line = line.rstrip(b'\r')
                if not line:
                    self.event()
                    self.lines = []
                elif line.startswith(b'data:'):
                    self.lines.append(line[5:].lstrip())
        except Exception:
            self.enabled = False
            self.buffer = b''
            self.lines = []
            self.state.update(self.record, sseObservation='event-parse-unavailable')

    def event(self):
        if not self.lines:
            return
        now = round((time.monotonic() - self.started) * 1000)
        if self.first_event is None:
            self.first_event = now
            self.state.update(self.record, firstEventMs=now, phase='stream-started')
        self.events += 1
        raw = b'\n'.join(self.lines)
        if raw == b'[DONE]':
            self.stopped = True
            return
        event = json.loads(raw)
        kind = event.get('type')
        if kind == 'content_block_start':
            block = event.get('content_block', {})
            if block.get('type') == 'tool_use':
                self.tools += 1
                self.content(now)
            if block.get('type') == 'text' and block.get('text'):
                self.output += len(block['text'])
                self.content(now)
        if kind == 'content_block_delta':
            delta = event.get('delta', {})
            if delta.get('type') == 'text_delta':
                self.output += len(delta.get('text', ''))
                self.content(now)
            elif delta.get('type') == 'input_json_delta':
                self.content(now)
            elif delta.get('type') == 'thinking_delta':
                self.thinking += len(delta.get('thinking', ''))
        if kind == 'message_stop':
            self.stopped = True
        self.state.update(self.record, sseEventCount=self.events, outputChars=self.output,
                          thinkingChars=self.thinking, toolStartCount=self.tools, messageStopObserved=self.stopped)

    def content(self, now):
        if self.first_content is None:
            self.first_content = now
            self.state.update(self.record, firstContentMs=now, phase='content-started')


def handler_for(state, upstream, environment):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            pass

        def body(self):
            if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
                parts, total = [], 0
                while True:
                    amount = int(self.rfile.readline().split(b';', 1)[0], 16)
                    if not amount:
                        while self.rfile.readline() not in [b'\r\n', b'\n', b'']:
                            pass
                        break
                    total += amount
                    if total > MAX_BODY:
                        raise ValueError('PROXY_BODY_TOO_LARGE')
                    parts.append(self.rfile.read(amount))
                    self.rfile.read(2)
                return b''.join(parts)
            amount = int(self.headers.get('Content-Length', '0'))
            if amount < 0 or amount > MAX_BODY:
                raise ValueError('PROXY_BODY_TOO_LARGE')
            return self.rfile.read(amount)

        def forward(self):
            started = time.monotonic()
            record, connection = None, None
            headers_sent = False
            try:
                raw = self.body()
                category = 'messages' if urllib.parse.urlsplit(self.path).path.endswith('/messages') else 'other-provider-request'
                metadata = {'phase': 'request-received', 'startedAtMs': round(time.time() * 1000),
                            'pathCategory': category, 'requestBodyBytes': len(raw),
                            'model': None, 'toolCount': None, 'toolNames': [], 'maxTokens': None,
                            'thinkingType': None, 'thinkingBudget': None, 'stream': None,
                            'httpStatus': None, 'firstEventMs': None, 'firstContentMs': None,
                            'elapsedMs': None, 'sseEventCount': 0, 'outputChars': 0, 'toolStartCount': 0}
                if category == 'messages':
                    try:
                        body = json.loads(raw)
                        tools = body.get('tools', [])
                        user_messages = [message for message in body.get('messages', []) if isinstance(message, dict) and message.get('role') == 'user']
                        latest_content = user_messages[-1].get('content', '') if user_messages else ''
                        latest_text = latest_content if isinstance(latest_content, str) else '\n'.join(block.get('text', '') for block in latest_content if isinstance(block, dict) and block.get('type') == 'text') if isinstance(latest_content, list) else ''
                        metadata['syntheticTaskTags'] = [tag for tag in ['ISSUE105_TEAMMATE_DENIED', 'ISSUE105_SUBAGENT_DENIED'] if tag in latest_text]
                        metadata.update(model=name(body.get('model')), maxTokens=integer(body.get('max_tokens')),
                                        stream=body.get('stream') is True,
                                        toolCount=len(tools) if isinstance(tools, list) else None,
                                        toolNames=[name(tool.get('name')) for tool in tools[:96]
                                                   if isinstance(tool, dict) and name(tool.get('name'))] if isinstance(tools, list) else [])
                        thinking = body.get('thinking', {})
                        if isinstance(thinking, dict):
                            metadata.update(thinkingType=name(thinking.get('type')), thinkingBudget=integer(thinking.get('budget_tokens')))
                    except Exception:
                        metadata['requestShapeUnavailable'] = True
                record = state.start(metadata)
                request_path = urllib.parse.urlsplit(self.path)
                prefix = upstream.path.rstrip('/')
                suffix = request_path.path
                if prefix.endswith('/v1') and suffix.startswith('/v1/'):
                    suffix = suffix[3:]
                target = prefix + suffix + ('?' + request_path.query if request_path.query else '')
                forwarded = {key: value for key, value in self.headers.items()
                             if key.lower() not in HOP_HEADERS and key.lower() not in ['host', 'content-length']}
                forwarded['Content-Length'] = str(len(raw))
                # Authorized credentials are never exposed. Preserve the actual
                # Claude auth unless it is absent; use configured auth then.
                if not self.headers.get('Authorization') and environment.get('ANTHROPIC_AUTH_TOKEN'):
                    forwarded['Authorization'] = 'Bearer ' + environment['ANTHROPIC_AUTH_TOKEN']
                if not self.headers.get('x-api-key') and environment.get('ANTHROPIC_API_KEY'):
                    forwarded['x-api-key'] = environment['ANTHROPIC_API_KEY']
                constructor = http.client.HTTPSConnection if upstream.scheme == 'https' else http.client.HTTPConnection
                connection = constructor(upstream.hostname, upstream.port, timeout=TIMEOUT)
                connection.request(self.command, target, body=raw, headers=forwarded)
                response = connection.getresponse()
                state.update(record, httpStatus=response.status, phase='upstream-headers',
                             upstreamHeadersMs=round((time.monotonic() - started) * 1000))
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in HOP_HEADERS:
                        self.send_header(key, value)
                self.send_header('Connection', 'close')
                self.end_headers()
                headers_sent = True
                encoding = response.getheader('Content-Encoding', '').lower()
                state.update(record, contentEncoding=encoding if encoding in ['gzip', 'deflate', 'br'] else 'identity' if encoding in ['', 'identity'] else 'other')
                witness = Witness(state, record, started, encoding)
                declared_sse = 'text/event-stream' in response.getheader('Content-Type', '').lower()
                is_sse = metadata.get('stream') is True or declared_sse
                state.update(record, declaredResponseType='event-stream' if declared_sse else 'other')
                while True:
                    remaining = TIMEOUT - (time.monotonic() - started)
                    if remaining <= 0:
                        raise TimeoutError()
                    if response.fp and response.fp.raw and response.fp.raw._sock:
                        response.fp.raw._sock.settimeout(remaining)
                    part = response.read1(4096)
                    if not part:
                        break
                    self.wfile.write(part)
                    self.wfile.flush()
                    if is_sse:
                        try:
                            witness.feed(part)
                        except Exception:
                            witness.enabled = False
                            state.update(record, sseObservation='observer-unavailable')
                completion = dict(phase='complete', elapsedMs=round((time.monotonic() - started) * 1000),
                                  responseEnded=True, messageStopObserved=witness.stopped if is_sse else None)
                if record is None or not record.get('sseObservation'):
                    completion['sseObservation'] = 'observed' if is_sse and witness.enabled and witness.events else 'not-observed'
                state.update(record, **completion)
            except (TimeoutError, socket.timeout):
                state.update(record, phase='timeout', elapsedMs=round((time.monotonic() - started) * 1000), responseEnded=False)
                if not headers_sent:
                    self.send_error(504)
            except (BrokenPipeError, ConnectionResetError):
                state.update(record, phase='client-disconnected', elapsedMs=round((time.monotonic() - started) * 1000), responseEnded=False)
            except Exception:
                state.update(record, phase='transport-error', elapsedMs=round((time.monotonic() - started) * 1000), responseEnded=False)
                if not headers_sent:
                    self.send_error(502)
            finally:
                if connection:
                    connection.close()
                self.close_connection = True

        do_POST = forward
        do_GET = forward

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-real-models', action='store_true', required=True)
    parser.add_argument('--scenario', choices=['exchange', 'isolation', 'busy', 'recovery', 'lifecycle', 'native-lifecycle', 'allowance', 'all'], default='exchange')
    parser.add_argument('--node', default=os.environ.get('ARLO_ACCEPTANCE_NODE', 'node'))
    parser.add_argument('--repo', type=Path, default=REPO,
                        help='Repository containing acceptance/claudecode/run.py.')
    parser.add_argument('--timeout-seconds', type=int, default=900)
    parser.add_argument('--disable-thinking', action='store_true',
                        help='Diagnostic only: request disabled thinking and 4096 output tokens in private settings.')
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--proxy-report', type=Path, required=True)
    args = parser.parse_args()
    args.repo = args.repo.resolve()
    args.report = args.report.resolve()
    args.proxy_report = args.proxy_report.resolve()
    os.umask(0o077)
    settings, environment, upstream = config()
    owner = str(uuid.uuid4())
    private = Path(tempfile.mkdtemp(prefix='arlo-issue105-proxy-'))
    atom(private / '.arlo-proxy-owner.json', {'owner': owner, 'purpose': 'issue105-provider-proxy'})
    state = State(args.proxy_report)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler_for(state, upstream, environment))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    local = 'http://127.0.0.1:' + str(server.server_port)
    settings.setdefault('env', {})['ANTHROPIC_BASE_URL'] = local
    if args.disable_thinking:
        settings['alwaysThinkingEnabled'] = False
        settings['env']['MAX_THINKING_TOKENS'] = '0'
        settings['env']['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = '4096'
        state.report['diagnosticConfigKeys'] = ['alwaysThinkingEnabled=false', 'MAX_THINKING_TOKENS=0', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096']
    atom(private / 'settings.json', settings)
    env = {**os.environ, 'ARLO_ACCEPTANCE_SETTINGS': str(private / 'settings.json'), 'ANTHROPIC_BASE_URL': local}
    if args.disable_thinking:
        env['MAX_THINKING_TOKENS'] = '0'
        env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = '4096'
    try:
        child = subprocess.Popen([sys.executable, str(args.repo / 'acceptance/claudecode/run.py'), '--allow-real-models',
                                  '--node', args.node, '--scenario', args.scenario,
                                  '--timeout-seconds', str(args.timeout_seconds), '--report', str(args.report)],
                                 cwd=args.repo, env=env)
        code = child.wait()
        with state.lock:
            state.report['acceptanceExitCode'] = code
            state.report['wrapperComplete'] = True
            for record in state.report['records']:
                if record['phase'] not in ['complete', 'timeout', 'transport-error', 'client-disconnected']:
                    record['phaseAtWrapperExit'] = record['phase']
                    record['wrapperEndedWhileInflight'] = True
            state.persist()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        marker = json.loads((private / '.arlo-proxy-owner.json').read_text())
        if marker.get('owner') == owner and marker.get('purpose') == 'issue105-provider-proxy':
            (private / 'settings.json').unlink(missing_ok=True)
            with state.lock:
                state.report['privateSettingsRemoved'] = True
                state.persist()
    if state.report.get('reportWriteFailed'):
        print(json.dumps({'failureCode': 'PROVIDER_REPORT_WRITE_FAILED'}), file=sys.stderr, flush=True)
        return 1
    return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'failureCode': 'PROVIDER_PROXY_DIAGNOSTIC_FAILED'}), flush=True)
        raise SystemExit(1)
