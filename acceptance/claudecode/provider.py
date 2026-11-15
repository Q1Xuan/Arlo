"""Opt-in provider differential diagnosis; never substitutes for Arlo acceptance.

Only synthetic requests are sent. Settings and raw response/error bodies remain
in memory; the JSON report contains fixed verdicts, timings and usage counters.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def configuration():
    settings = Path(os.environ.get('ARLO_ACCEPTANCE_SETTINGS', str(Path.home() / '.claude/settings.json')))
    value = json.loads(settings.read_text()).get('env', {})
    env = {**value, **os.environ}
    base = env.get('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme not in ['https', 'http'] or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment):
        raise ValueError()
    model = env.get('ANTHROPIC_MODEL')
    token = env.get('ANTHROPIC_AUTH_TOKEN')
    api_key = env.get('ANTHROPIC_API_KEY')
    if not isinstance(model, str) or not model or not (token or api_key):
        raise ValueError()
    url = base + ('/messages' if parsed.path.rstrip('/').endswith('/v1') else '/v1/messages')
    headers = {'Content-Type': 'application/json', 'anthropic-version': '2023-06-01'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if api_key:
        headers['x-api-key'] = api_key
    return url, model, headers


def usage_counters(value):
    result = {}
    for key in ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']:
        number = value.get(key) if isinstance(value, dict) else None
        if isinstance(number, int) and not isinstance(number, bool) and number >= 0:
            result[key] = number
    return result


def round_request(index, kind, url, model, headers):
    expected = 'ISSUE105_PROVIDER_REPLY: 42'
    payload = {'model': model, 'max_tokens': 256, 'stream': False,
               'system': 'You are participating in a small synthetic diagnostic. Follow the requested output format exactly.',
               'messages': [{'role': 'user', 'content': 'What is 23 + 19? Reply exactly ' + expected + '.'}]}
    if kind == 'tool':
        payload['messages'][0]['content'] = ('Call synthetic_echo exactly once with answer=42 and '
                                           'tag="ISSUE105_PROVIDER". Do not return prose. This is a synthetic diagnostic tool.')
        payload['tools'] = [{'name': 'synthetic_echo', 'description': 'Echo a synthetic arithmetic answer for diagnosis.',
                             'input_schema': {'type': 'object', 'properties': {
                                 'answer': {'type': 'integer'}, 'tag': {'type': 'string'}},
                                 'required': ['answer', 'tag'], 'additionalProperties': False}}]
        payload['tool_choice'] = {'type': 'tool', 'name': 'synthetic_echo'}
    report = {'round': index, 'kind': kind, 'httpStatus': None, 'status': 'request-failed',
              'expectedAnswer': False, 'expectedToolCall': False, 'usage': {}}
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method='POST')
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(request, timeout=30) as response:
            report['httpStatus'] = response.status
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                report['status'] = 'response-too-large'
                return report
        try:
            result = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            report['status'] = 'invalid-json'
            return report
        if not isinstance(result, dict) or not isinstance(result.get('content'), list):
            report['status'] = 'invalid-message-envelope'
            return report
        content = result['content']
        texts = [part.get('text', '') for part in content if isinstance(part, dict) and part.get('type') == 'text']
        tools = [part for part in content if isinstance(part, dict) and part.get('type') == 'tool_use']
        report['expectedAnswer'] = any(re.fullmatch(r'\s*' + re.escape(expected) + r'\s*', text) for text in texts)
        report['expectedToolCall'] = (len(tools) == 1 and tools[0].get('name') == 'synthetic_echo' and
                                      tools[0].get('input') == {'answer': 42, 'tag': 'ISSUE105_PROVIDER'})
        report['usage'] = usage_counters(result.get('usage'))
        report['status'] = 'passed' if (report['expectedToolCall'] if kind == 'tool' else report['expectedAnswer']) else 'unexpected-output'
    except urllib.error.HTTPError as error:
        report['httpStatus'] = error.code
        report['status'] = 'http-error'
        error.close()
    except (TimeoutError, socket.timeout):
        report['status'] = 'timeout'
    except urllib.error.URLError as error:
        report['status'] = 'timeout' if isinstance(error.reason, (TimeoutError, socket.timeout)) else 'network-error'
    except Exception:
        report['status'] = 'request-failed'
    finally:
        report['elapsedMs'] = round((time.monotonic() - started) * 1000)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-real-models', action='store_true', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    report = {'schemaVersion': 1, 'issue': 105, 'scope': 'provider-diagnosis-only',
              'countsAsAcceptance': False, 'startedAt': datetime.now(timezone.utc).isoformat(),
              'mode': 'nonstreaming-Anthropic-Messages', 'roundsPerKind': 5,
              'maxConcurrentRequests': 3, 'requestTimeoutSeconds': 30, 'maxTokensPerRequest': 256,
              'providerModel': None, 'results': [], 'passed': False}
    try:
        url, model, headers = configuration()
        # The model identifier is configuration metadata, never an endpoint or credential.
        report['providerModel'] = model if re.fullmatch(r'[a-zA-Z0-9._:/-]{1,100}', model) else 'configured-model'
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(round_request, index, kind, url, model, headers)
                       for kind in ['arithmetic', 'tool'] for index in range(1, 6)]
            for future in as_completed(futures):
                result = future.result()
                report['results'].append(result)
                print(json.dumps(result), flush=True)
        report['results'].sort(key=lambda row: (row['kind'], row['round']))
        report['passed'] = all(row['status'] == 'passed' for row in report['results'])
    except Exception:
        report['failureCode'] = 'PROVIDER_DIAGNOSTIC_CONFIGURATION_OR_EXECUTION_FAILED'
    report['finishedAt'] = datetime.now(timezone.utc).isoformat()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.report.with_suffix(args.report.suffix + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(args.report)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
