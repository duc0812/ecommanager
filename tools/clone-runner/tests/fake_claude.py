"""Stands in for the claude CLI in the session tests; FAKE_CLAUDE_MODE picks what it does. It calls nothing outside.

Every mode first writes fake.json (its pid, cwd, argv and the store and worker variables it was given) in the cwd.
  pass       result.json PASS, CLI JSON on stdout (cost, duration), a line on stderr, exit 0
  text       result.json PASS, plain text on stdout, exit 0
  crash      no result.json, exit 2
  pass-exit1 result.json PASS, exit 1
  gap-exit1  result.json FAIL TOOL_GAP, exit 1
  sleep      starts a grandchild that sleeps (pid in grandchild.pid), then sleeps itself
"""
import json
import os
import subprocess
import sys
import time

GID = 'gid://shopify/Product/9054123557021'
WATCHED = ('SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_API_VERSION', 'CLONE_WORKER_TOKEN', 'OTHER_WORKER_TOKEN')
PASS = {'verdict': 'PASS', 'platform': 'customily', 'productGid': GID, 'handle': 'family-ornament',
        'productType': 'Ornament', 'note': 'compare.png matches the source'}


def write(name, data):
    with open(name, 'w', encoding='utf-8') as fh:
        json.dump(data, fh)


def main():
    mode = os.environ.get('FAKE_CLAUDE_MODE', 'pass')
    write('fake.json', {'pid': os.getpid(), 'cwd': os.getcwd(), 'argv': sys.argv[1:],
                        'env': {k: os.environ.get(k) for k in WATCHED}})
    if mode == 'sleep':
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        with open('grandchild.pid', 'w', encoding='utf-8') as fh:
            fh.write(str(child.pid))
        time.sleep(60)
        return 0
    if mode == 'crash':
        print('boom', file=sys.stderr)
        return 2
    if mode == 'gap-exit1':
        write('result.json', {'verdict': 'FAIL', 'failKind': 'TOOL_GAP', 'error': 'needs a new layer rule'})
        return 1
    write('result.json', PASS)
    if mode == 'pass-exit1':
        return 1
    if mode == 'text':
        print('done, no JSON here')
        return 0
    print('progress on stderr', file=sys.stderr, flush=True)
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'total_cost_usd': 1.25,
                      'duration_ms': 4321, 'result': 'ok'}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
