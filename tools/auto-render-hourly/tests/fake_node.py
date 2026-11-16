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
    for line in p.get('print', []):
        print(line, flush=True)
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
    if '--to-queue' in args:
        qa = json.loads(Path(opt('--qa-json')).read_text(encoding='utf-8')) if opt('--qa-json') else None
        with open(D / 'queue-calls.jsonl', 'a', encoding='utf-8') as fh:
            fh.write(json.dumps({'script': name, 'keys': keys, 'qa': qa, 'root': os.environ.get('REVIEW_QUEUE_ROOT'),
                                 'token': os.environ.get('DESIGN_WORKER_TOKEN')}) + '\n')
        said = {'enqueued': 'vào hàng chờ', 'unchanged': 'không đổi (đã có trong hàng chờ)', 'fixing': 'không đổi (agent đang sửa)',
                'bypassed': 'giao thẳng (chỉ dùng lại file đã có trên Drive)', 'refused': 'không vào hàng chờ: đã có trong hàng chờ rq_other',
                'waiting': 'chờ: dòng đầu chưa có trên Drive'}
        q = {k: plan.get('queue', {}).get(k, 'enqueued') for k in keys}
        if 'crash' in q.values():
            print('Error: intake crashed', flush=True)
            sys.exit(1)
        print(f'\n== Hàng chờ duyệt local ({os.environ.get("REVIEW_QUEUE_ROOT")}): {len(keys)} dòng ==', flush=True)
        for k in keys:
            if q[k] != 'missing':
                print(f'  {k}  {said[q[k]]}', flush=True)
        print(f'{len(keys)} dòng · vào hàng chờ {sum(v == "enqueued" for v in q.values())} · không đổi 0 · giao thẳng 0', flush=True)
        bypassed = [k for k in keys if q[k] == 'bypassed']
        if bypassed:
            out = Path(opt('--out')) if opt('--out') else Path(os.environ['FAKE_MAIN_CHECKOUT']) / 'db-backups' / name
            out.mkdir(parents=True, exist_ok=True)
            ledger_path = out / 'api-ledger.json'
            ledger = json.loads(ledger_path.read_text(encoding='utf-8')) if ledger_path.exists() else {'lines': {}}
            at = datetime.now(timezone.utc).isoformat(timespec='milliseconds')
            for k in bypassed:
                ledger['lines'][f'{k}#q'] = {'taskKey': k, 'action': 'push', 'files': {}, 'applied': at, 'result': {'status': 'REVIEW'}}
            ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
        sys.exit(1 if 'refused' in q.values() else 0)
    if opt('--via') == 'api':
        with open(D / 'api-env.jsonl', 'a', encoding='utf-8') as fh:
            fh.write(json.dumps({k: os.environ.get(k) for k in ('ECOM_URL', 'DESIGN_WORKER_TOKEN')}) + '\n')
        print(f'{name} --via api {",".join(keys)} auth={os.environ.get("DESIGN_WORKER_TOKEN")}', flush=True)
        if 'exit1' in outcomes.values():
            sys.exit(1)
        out = Path(opt('--out')) if opt('--out') else Path(os.environ['FAKE_MAIN_CHECKOUT']) / 'db-backups' / name
        out.mkdir(parents=True, exist_ok=True)
        ledger_path = out / 'api-ledger.json'
        ledger = json.loads(ledger_path.read_text(encoding='utf-8')) if ledger_path.exists() else {'lines': {}}
        at = datetime.now(timezone.utc).isoformat(timespec='milliseconds')
        for k, o in outcomes.items():
            entry = {'taskKey': k, 'action': 'push', 'files': {}}
            if o == 'applied':
                entry.update(applied=at, result={'status': 'REVIEW'})
            elif o == 'old':
                entry.update(applied='2020-01-01T00:00:00.000Z', result={'status': 'REVIEW'})
            elif o == 'skipped':
                entry['skippedOnProd'] = {'code': 'not_found', 'error': 'task không có trên prod', 'status': 404}
            elif o == 'stale':
                entry['skippedOnProd'] = {'code': 'stale', 'error': 'task trên prod đang REVIEW, kế hoạch cần NEW', 'status': None}
            elif o == 'stop':
                print('DỪNG: GET /tasks: không được phép (401) — ledger giữ nguyên', flush=True)
                sys.exit(1)
            if o != 'noledger':
                ledger['lines'][f'{k}#{o}'] = entry
        ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
        sys.exit(0)
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
