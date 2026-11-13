"""A stand-in for `codex.exe`. Started as [python, fake_codex.py, exec, -C <job dir>, ..., -o <last message>, <prompt>].

What it does per round: FAKE_CODEX_PLAN (JSON list, the last entry repeats), else FAKE_CODEX_MODE (default `ready`).
- ready: round-N/deliver/ files + round-N/READY.json
- needs-owner: result.json NEEDS_OWNER
- nothing: exits without writing anything (after FAKE_CODEX_SLEEP seconds)
- hang: starts a grandchild and sleeps
FAKE_CODEX_ECHO_FILE names a file whose content is printed (to check masking in the session log).
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

args = sys.argv[1:]
job_dir = Path(args[args.index('-C') + 1])
last = Path(args[args.index('-o') + 1])
round_n = int(re.search(r'round-(\d+)', last.as_posix()).group(1))
plan = json.loads(os.environ.get('FAKE_CODEX_PLAN') or '[]')
action = plan[min(round_n, len(plan)) - 1] if plan else os.environ.get('FAKE_CODEX_MODE', 'ready')
SCRUBBED = ('CLAUDE', 'ANTHROPIC', 'MCP_')

data = json.dumps({'argv': args, 'cwd': os.getcwd(), 'pid': os.getpid(), 'round': round_n,
                   'env': {'DESIGN_AGENT_TOKEN': os.environ.get('DESIGN_AGENT_TOKEN'),
                           'DESIGN_AGENT_ENV': os.environ.get('DESIGN_AGENT_ENV'),
                           'scrubbed': sorted(k for k in os.environ if k.upper().startswith(SCRUBBED))},
                   'envValues': sorted(os.environ.values())})
(job_dir / f'fake-codex-{round_n}.json').write_text(data, encoding='utf-8')
print('OpenAI Codex (fake)\n--------\nsession id: fake-session\n--------', flush=True)
echo = os.environ.get('FAKE_CODEX_ECHO_FILE')
if echo:
    print('token is', Path(echo).read_text(encoding='utf-8').strip(), flush=True)


def ready():
    kind = json.loads((job_dir / 'job.json').read_text(encoding='utf-8'))['kind']
    (job_dir / 'stage.txt').write_text('sửa từ PSD', encoding='utf-8')
    rd = job_dir / f'round-{round_n}'
    deliver = rd / 'deliver'
    deliver.mkdir(parents=True, exist_ok=True)
    files = []
    if kind != 'MOCKUP':
        (deliver / 'FRONT.jpg').write_bytes(f'codex-front-r{round_n}'.encode())
        files.append({'kind': 'PRINT', 'printArea': 'FRONT', 'file': f'round-{round_n}/deliver/FRONT.jpg'})
    (deliver / 'Preview.png').write_bytes(f'codex-mock-r{round_n}'.encode())
    files.append({'kind': 'MOCKUP', 'printArea': 'Preview', 'file': f'round-{round_n}/deliver/Preview.png'})
    (rd / 'READY.json').write_text(json.dumps(
        {'round': round_n, 'files': files, 'changed': f'Codex vòng {round_n}: dời lớp sao trong PSD rồi xuất lại.',
         'unchanged': 'Giữ nguyên tay áo và mũ.'}, ensure_ascii=False), encoding='utf-8')


if action == 'ready':
    ready()
elif action == 'needs-owner':
    (job_dir / 'result.json').write_text(json.dumps(
        {'outcome': 'NEEDS_OWNER', 'summary': 'Không có PSD nguồn cho mảnh FRONT.'}, ensure_ascii=False), encoding='utf-8')
elif action == 'nothing':
    time.sleep(float(os.environ.get('FAKE_CODEX_SLEEP', '0')))
elif action == 'hang':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    (job_dir / 'codex-grandchild.pid').write_text(str(child.pid), encoding='utf-8')
    time.sleep(120)
else:
    sys.exit(9)
last.write_text(f'done: {action}', encoding='utf-8')
