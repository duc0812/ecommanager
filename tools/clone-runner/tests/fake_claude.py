"""Stands in for the claude CLI in the session tests; FAKE_CLAUDE_MODE picks what it does. It calls nothing outside.

Every mode first writes fake.json (its pid, cwd, argv, the store, worker and session variables it was given, and which
start-up files it found in the cwd) in the cwd. The modes that print CLI output print it as `stream-json` does: one
JSON object per line, the last one of type "result".
  pass        result.json PASS, stream lines on stdout (init, assistant, user, result with cost and duration), a line
              on stderr, exit 0
  pass-reused like pass, with "reused": true in result.json
  echo-secret like pass, after printing its own SHOPIFY_ADMIN_TOKEN on stdout (split over two writes), in a stream line
              and on stderr
  leak-result result.json FAIL with its own SHOPIFY_ADMIN_TOKEN in note, error and handle, exit 0
  text        result.json PASS, plain text on stdout, exit 0
  crash       no result.json, no CLI output, exit 2
  cli-down    no result.json, an init line and an is_error result after 1 turn (a logged-out CLI), exit 1
  late-error  no result.json, many stream lines and an is_error result after 25 turns, exit 1
  pass-exit1  result.json PASS, exit 1
  gap-exit1   result.json FAIL TOOL_GAP, exit 1
  sleep       starts a grandchild that sleeps (pid in grandchild.pid), then sleeps itself
"""
import json
import os
import subprocess
import sys
import time

GID = 'gid://shopify/Product/9054123557021'
WATCHED = ('SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_API_VERSION', 'CLONE_WORKER_TOKEN', 'OTHER_WORKER_TOKEN',
           'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'DISABLE_AUTOUPDATER')
STARTUP_FILES = ('.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json')
PASS = {'verdict': 'PASS', 'platform': 'customily', 'productGid': GID, 'handle': 'family-ornament',
        'productType': 'Ornament', 'note': 'compare.png matches the source'}
INIT = {'type': 'system', 'subtype': 'init', 'session_id': 'fake-session', 'tools': ['Read', 'Bash']}


def write(name, data):
    with open(name, 'w', encoding='utf-8') as fh:
        json.dump(data, fh)


def stream(*objects):
    for obj in objects:
        print(json.dumps(obj), flush=True)


def said(text):
    return {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}}


def tool_result(text):
    return {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'content': text}]}}


def main():
    mode = os.environ.get('FAKE_CLAUDE_MODE', 'pass')
    write('fake.json', {'pid': os.getpid(), 'cwd': os.getcwd(), 'argv': sys.argv[1:],
                        'env': {k: os.environ.get(k) for k in WATCHED},
                        'startupFiles': [n for n in STARTUP_FILES if os.path.lexists(n)]})
    if mode == 'echo-secret':
        token = os.environ.get('SHOPIFY_ADMIN_TOKEN', '')
        sys.stdout.write('token is ' + token[:9])
        sys.stdout.flush()
        time.sleep(0.3)
        sys.stdout.write(token[9:] + ' (echoed)\n')
        sys.stdout.flush()
        stream(said('the store token is ' + token))
        print('stderr ' + token, file=sys.stderr, flush=True)
    if mode == 'sleep':
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        with open('grandchild.pid', 'w', encoding='utf-8') as fh:
            fh.write(str(child.pid))
        time.sleep(60)
        return 0
    if mode == 'crash':
        print('boom', file=sys.stderr)
        return 2
    if mode == 'cli-down':
        stream(INIT, {'type': 'result', 'subtype': 'success', 'is_error': True, 'num_turns': 1, 'duration_ms': 812,
                      'total_cost_usd': 0, 'result': 'Invalid API key · Please run /login'})
        return 1
    if mode == 'late-error':
        stream(INIT, said('cloning'), tool_result('product 9054123557021 DRAFT family-ornament'), said('running qa'),
               {'type': 'result', 'subtype': 'error_max_budget_usd', 'is_error': True, 'num_turns': 25,
                'duration_ms': 3_600_000, 'total_cost_usd': 8.01})
        return 1
    if mode == 'leak-result':
        token = os.environ.get('SHOPIFY_ADMIN_TOKEN', '')
        write('result.json', {'verdict': 'FAIL', 'failKind': 'QA', 'productGid': GID, 'handle': 'h-' + token,
                              'note': 'compared with token ' + token, 'error': f'store said {token} is bad'})
        return 0
    if mode == 'gap-exit1':
        write('result.json', {'verdict': 'FAIL', 'failKind': 'TOOL_GAP', 'error': 'needs a new layer rule'})
        return 1
    write('result.json', {**PASS, 'reused': True} if mode == 'pass-reused' else PASS)
    if mode == 'pass-exit1':
        return 1
    if mode == 'text':
        print('done, no JSON here')
        return 0
    print('progress on stderr', file=sys.stderr, flush=True)
    stream(INIT, said('cloning the product'), tool_result('qa_report PASS'),
           {'type': 'result', 'subtype': 'success', 'is_error': False, 'num_turns': 3, 'total_cost_usd': 1.25,
            'duration_ms': 4321, 'result': 'ok'})
    return 0


if __name__ == '__main__':
    sys.exit(main())
