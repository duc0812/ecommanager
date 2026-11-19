"""A stand-in for the `claude` executable. Started as [python, fake_claude.py, ...claude args].

What it does is picked per session:
- FAKE_CLAUDE_PLAN (JSON, e.g. {"maker": ["ready"], "qa": ["fail", "pass"]}) gives the action per phase and round
  (DESIGN_AGENT_PHASE / DESIGN_AGENT_ROUND, set by the runner; the last entry repeats);
- otherwise FAKE_CLAUDE_MODE applies to every session.
`done` means: maker writes READY + files, QA writes PASS, a single (library) session delivers through agent_api.py.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent
job_dir = Path(os.environ['DESIGN_AGENT_JOB_DIR'])
mode = os.environ.get('FAKE_CLAUDE_MODE', 'done')
phase = os.environ.get('DESIGN_AGENT_PHASE', '')
round_n = int(os.environ.get('DESIGN_AGENT_ROUND') or 0)
plan = json.loads(os.environ.get('FAKE_CLAUDE_PLAN') or '{}')
steps = plan.get(phase) if phase else None
action = steps[min(round_n, len(steps)) - 1] if steps else mode


def record():
    names = ('DESIGN_AGENT_TOKEN', 'BASH_MAX_TIMEOUT_MS', 'DISABLE_AUTOUPDATER')
    data = json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'pid': os.getpid(), 'phase': phase, 'round': round_n,
                       'env': {n: os.environ.get(n) for n in names}})
    (job_dir / 'fake.json').write_text(data, encoding='ascii')
    if phase:
        (job_dir / f'fake-{phase}-{round_n}.json').write_text(data, encoding='ascii')


def nap():
    time.sleep(float(os.environ.get('FAKE_CLAUDE_NAP', '0')))


def write_result(obj):
    if isinstance(obj, str):
        (job_dir / 'result.json').write_text(obj, encoding='utf-8')
    else:
        (job_dir / 'result.json').write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8-sig')


def deliver():
    key = json.loads((job_dir / 'job.json').read_text(encoding='utf-8'))['task']['key']
    (job_dir / 'stage.txt').write_text('vòng 1: codex', encoding='utf-8')
    (job_dir / 'round-1').mkdir(exist_ok=True)
    art = job_dir / 'round-1' / 'FRONT.jpg'
    art.write_bytes(b'fake-front')
    api = str(TOOL / 'agent_api.py')
    for cmd in (['upload', key, 'FRONT', str(art)], ['submit', key]):
        subprocess.run([sys.executable, api, *cmd], check=True, stdout=subprocess.DEVNULL)
    write_result({'outcome': 'DONE', 'summary': 'Đã sửa thân trước: dời tên vào trong khung.', 'rounds': 1,
                  'pushed': ['FRONT'], 'problems': []})
    print(json.dumps({'type': 'result', 'is_error': False}), flush=True)


def make_ready(outside=False):
    kind = json.loads((job_dir / 'job.json').read_text(encoding='utf-8'))['kind']
    (job_dir / 'stage.txt').write_text(f'vòng {round_n}: codex', encoding='utf-8')
    rd = job_dir / f'round-{round_n}'
    deliver_dir = rd / 'deliver'
    deliver_dir.mkdir(parents=True, exist_ok=True)
    nap()
    files = []
    if kind != 'MOCKUP':
        art = (rd if outside else deliver_dir) / 'FRONT.jpg'
        art.write_bytes(f'fake-front-r{round_n}'.encode())
        files.append({'kind': 'PRINT', 'printArea': 'FRONT', 'file': art.relative_to(job_dir).as_posix()})
    (deliver_dir / 'Preview.png').write_bytes(f'fake-mock-r{round_n}'.encode())
    files.append({'kind': 'MOCKUP', 'printArea': 'Preview', 'file': f'round-{round_n}/deliver/Preview.png'})
    (rd / 'READY.json').write_text(json.dumps(
        {'round': round_n, 'files': files, 'changed': f'Vòng {round_n}: dời tên vào trong khung.',
         'unchanged': 'Giữ nguyên tay áo và mũ.'}, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'type': 'result', 'is_error': False}), flush=True)


def qa(verdict, tamper=False):
    nap()
    if tamper:
        target = next((job_dir / f'round-{round_n}' / 'deliver').iterdir())
        target.write_bytes(target.read_bytes() + b'-touched')
    out = job_dir / 'QA-claude'
    out.mkdir(exist_ok=True)
    findings = [] if verdict == 'PASS' else [
        {'piece': 'FRONT', 'problem': f'logo chạm tên khách (vòng {round_n})', 'fix': 'dời logo lên 120 px, giữ nhóm nhân vật',
         'passCondition': 'logo cách tên ít nhất 40 px'}]
    summary = 'QA độc lập: đạt cả 8 mục.' if verdict == 'PASS' else 'QA độc lập: logo chạm tên.'
    (out / f'round-{round_n}-result.json').write_text(json.dumps(
        {'verdict': verdict, 'summary': summary, 'findings': findings}, ensure_ascii=False), encoding='utf-8')


record()
print(json.dumps({'type': 'system', 'subtype': 'init'}), flush=True)
if action == 'echo-token':
    token = ''
    for line in Path(os.environ['DESIGN_AGENT_ENV']).read_text(encoding='utf-8').splitlines():
        if line.startswith('DESIGN_AGENT_TOKEN='):
            token = line.split('=', 1)[1]
    print('token is', token, flush=True)
    action = 'done'
if action in ('done', 'ready') and phase == 'maker':
    make_ready()
elif action in ('done', 'pass') and phase == 'qa':
    qa('PASS')
elif action == 'done':
    deliver()
elif action == 'ready-outside':
    make_ready(outside=True)
elif action == 'fail':
    qa('FAIL')
elif action == 'tamper':
    qa('PASS', tamper=True)
elif action == 'qa-bad':
    (job_dir / 'QA-claude').mkdir(exist_ok=True)
    (job_dir / 'QA-claude' / f'round-{round_n}-result.json').write_text('{"verdict": "MAYBE"}', encoding='utf-8')
elif action == 'needs-owner':
    write_result({'outcome': 'NEEDS_OWNER', 'summary': 'Sau 3 vòng tay áo vẫn lệch đường may.', 'rounds': 3,
                  'pushed': [], 'problems': ['tay áo'],
                  **({'ask': json.loads(os.environ['FAKE_CLAUDE_ASK'])} if os.environ.get('FAKE_CLAUDE_ASK') else {})})
elif action == 'stream-then-hang':
    print(json.dumps({'type': 'assistant', 'note': 'EVENT-BEFORE-KILL'}), flush=True)
    time.sleep(120)
elif action in ('no-result', 'nothing'):
    time.sleep(float(os.environ.get('FAKE_CLAUDE_SLEEP', '0')))
elif action == 'fast-exit':
    print('Invalid API key · Please run /login')
    sys.exit(1)
elif action == 'bad-json':
    write_result('{oops')
elif action == 'bad-outcome':
    write_result({'outcome': 'PASS', 'summary': 'x'})
elif action == 'claims-done':
    write_result({'outcome': 'DONE', 'summary': 'Đã giao.'})
elif action == 'sleep':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    (job_dir / 'grandchild.pid').write_text(str(child.pid), encoding='utf-8')
    time.sleep(120)
elif action == 'ps-lock':
    (job_dir.parent / '.ps-lock').mkdir()
    (job_dir / 'ps-lock.held').write_text('', encoding='utf-8')
    time.sleep(120)
else:
    sys.exit(9)
