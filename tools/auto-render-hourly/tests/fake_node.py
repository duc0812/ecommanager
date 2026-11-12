"""Stands in for `node` in the tests: records each call and acts out the script named first, from <FAKE_NODE_DIR>/plan.json."""
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

D = Path(os.environ['FAKE_NODE_DIR'])
script, args = (sys.argv[1] if len(sys.argv) > 1 else ''), sys.argv[2:]
with open(D / 'calls.jsonl', 'a', encoding='utf-8') as fh:
    fh.write(json.dumps({'script': script, 'args': args, 'cwd': os.getcwd()}) + '\n')
plan = json.loads((D / 'plan.json').read_text(encoding='utf-8')) if (D / 'plan.json').exists() else {}


def opt(flag, default=None):
    return args[args.index(flag) + 1] if flag in args else default


class NotFound(BaseHTTPRequestHandler):
    def _answer(self):
        self.send_response(404)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error":"not found"}')

    do_GET = do_POST = _answer

    def log_message(self, *a):
        pass


if script.endswith('next'):
    (D / 'tool.pid').write_text(str(os.getpid()))
    ThreadingHTTPServer(('127.0.0.1', int(opt('--port'))), NotFound).serve_forever()

elif script.endswith('process-new-orders.mjs'):
    p = plan.get('process', {})
    out = Path(opt('--out'))
    out.mkdir(parents=True, exist_ok=True)
    print('12 dòng NEW chưa có file in (từ %s)' % opt('--since'), flush=True)
    if p.get('sleep'):
        time.sleep(p['sleep'])
    if not p.get('noSnapshot'):
        snap = Path(p['snapshot'])
        snap.parent.mkdir(parents=True, exist_ok=True)
        if p.get('snapshotFrom'):
            shutil.copyfile(p['snapshotFrom'], snap)
        else:
            snap.write_bytes(b'')
        print(f'snapshot {snap}', flush=True)
    if 'shared' in p:
        (out / 'spec-shared.json').write_text(json.dumps(p['shared']), encoding='utf-8')
    if 'flat' in p:
        (out / 'flat-text.json').write_text(json.dumps(p['flat']), encoding='utf-8')
    print('Chưa đẩy gì lên prod.', flush=True)
    sys.exit(p.get('exit', 0))

elif script.endswith('push-local-renders.mjs') or script.endswith('push-shared-prints.mjs'):
    name = Path(script).stem
    stage = next((a for a in args if a in ('--apply', '--prove', '--push')), None)
    if opt('--line'):
        keys = [opt('--line')]
    else:
        keys = [k for g in json.loads(Path(opt('--spec')).read_text(encoding='utf-8'))['groups'] for k in g['lines']]
    outcomes = {k: plan.get('push', {}).get(k, 'applied') for k in keys}
    print(f'{name} {stage} {",".join(keys)}', flush=True)
    if stage == '--apply' and 'exit1' in outcomes.values():
        sys.exit(1)
    if stage == '--push':
        out = Path(opt('--out')) if opt('--out') else Path(os.environ['FAKE_MAIN_CHECKOUT']) / 'db-backups' / name
        out.mkdir(parents=True, exist_ok=True)
        ledger_path = out / 'ledger.json'
        ledger = json.loads(ledger_path.read_text(encoding='utf-8')) if ledger_path.exists() else {'chunks': {}, 'lines': {}}
        at = datetime.now(timezone.utc).isoformat(timespec='milliseconds')
        for k, o in outcomes.items():
            if o == 'applied':
                ledger['lines'][k] = {**ledger['lines'].get(k, {'files': {}}), 'applied': at, 'chunk': 'chunk-01.json'}
            elif o == 'skipped':
                ledger['lines'][k] = {**ledger['lines'].get(k, {'files': {}}), 'skippedOnProd': 'Task trên prod đang REVIEW', 'chunk': 'chunk-01.json'}
            elif o == 'stop':
                print('  DỪNG: app không online trước chunk-x.json', flush=True)
        ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
    sys.exit(0)

else:
    print(f'fake node: unknown script {script}', file=sys.stderr)
    sys.exit(9)
