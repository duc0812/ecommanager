"""A stand-in for the `claude` executable. Started as [python, fake_claude.py, ...claude args]; FAKE_CLAUDE_MODE picks what it does."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent
job_dir = Path(os.environ['DESIGN_AGENT_JOB_DIR'])
mode = os.environ.get('FAKE_CLAUDE_MODE', 'done')


def record():
    names = ('DESIGN_AGENT_TOKEN', 'BASH_MAX_TIMEOUT_MS', 'DISABLE_AUTOUPDATER')
    (job_dir / 'fake.json').write_text(json.dumps(
        {'argv': sys.argv[1:], 'cwd': os.getcwd(), 'pid': os.getpid(), 'env': {n: os.environ.get(n) for n in names}}), encoding='ascii')


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
    print(json.dumps({'type': 'result', 'is_error': False}))


record()
if mode == 'done':
    deliver()
elif mode == 'echo-token':
    token = ''
    for line in Path(os.environ['DESIGN_AGENT_ENV']).read_text(encoding='utf-8').splitlines():
        if line.startswith('DESIGN_AGENT_TOKEN='):
            token = line.split('=', 1)[1]
    print('token is', token, flush=True)
    deliver()
elif mode == 'needs-owner':
    write_result({'outcome': 'NEEDS_OWNER', 'summary': 'Sau 3 vòng tay áo vẫn lệch đường may.', 'rounds': 3,
                  'pushed': [], 'problems': ['tay áo']})
elif mode == 'no-result':
    time.sleep(float(os.environ.get('FAKE_CLAUDE_SLEEP', '0')))
elif mode == 'fast-exit':
    print('Invalid API key · Please run /login')
    sys.exit(1)
elif mode == 'bad-json':
    write_result('{oops')
elif mode == 'bad-outcome':
    write_result({'outcome': 'PASS', 'summary': 'x'})
elif mode == 'sleep':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    (job_dir / 'grandchild.pid').write_text(str(child.pid), encoding='utf-8')
    time.sleep(120)
elif mode == 'ps-lock':
    (job_dir.parent / '.ps-lock').mkdir()
    (job_dir / 'ps-lock.held').write_text('', encoding='utf-8')
    time.sleep(120)
else:
    sys.exit(9)
