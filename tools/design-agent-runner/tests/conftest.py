import json
import os
import sys
import time
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
for p in (str(HERE), str(TOOL)):
    if p in sys.path:
        sys.path.remove(p)
    sys.path.insert(0, p)

from fake_server import FakeServer  # noqa: E402


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    home = tmp_path / 'home'
    home.mkdir()
    monkeypatch.setenv('DESIGN_AGENT_HOME', str(home))
    for name in ('DESIGN_AGENT_ENV', 'DESIGN_AGENT_JOB_DIR', 'DESIGN_AGENT_TOKEN', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_SLEEP'):
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.fixture
def server():
    s = FakeServer().start()
    yield s
    s.stop()


def pid_alive(pid: int) -> bool:
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = k32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def wait_dead(pid: int, within: float = 10) -> bool:
    deadline = time.monotonic() + within
    while pid_alive(pid):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.1)
    return True


def wait_until(cond, within: float = 15):
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.05)
    raise AssertionError('condition never became true')


def calls(server, suffix):
    return [b for _, p, b in server.calls if p.endswith(suffix)]


def max_running(server):
    """Most jobs between their first heartbeat and their result or fail, from the times the fake server keeps."""
    start, end = {}, {}
    for t, path in server.times:
        if '/jobs/' in path:
            parts = path.split('/')
            jid, action = parts[-2], parts[-1]
            if action == 'heartbeat':
                start.setdefault(jid, t)
            elif action in ('result', 'fail'):
                end[jid] = t
    events = sorted([(t, 1) for t in start.values()] + [(t, -1) for t in end.values()])
    best = cur = 0
    for _, d in events:
        cur += d
        best = max(best, cur)
    return best


class FakeClock:
    """Records the seconds asked for and returns at once; `monotonic` is real."""
    _stops: dict = {}

    def __init__(self, sleeps):
        self.sleeps = sleeps

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        target = FakeClock._stops.get(id(self.sleeps))
        if target and len(self.sleeps) >= target[0]:
            target[1].set()

    def monotonic(self):
        return time.monotonic()

    def time(self):
        return time.time()

    @classmethod
    def stop_after(cls, sleeps, n, stop):
        cls._stops[id(sleeps)] = (n, stop)


def fake_pid(d, folder):
    p = d.cfg.artwork_builder / folder / 'fake.json'
    wait_until(p.exists)
    return json.loads(p.read_text(encoding='utf-8'))['pid']


@pytest.fixture(name='job')
def _job_factory():
    def job(kind='FIX', key='LIT6262_1', id='job1', attempts=1, files=None, **over):
        if files is None:
            files = [dict(id='art1', kind='PRINT', printArea='FRONT', version=1, fileName='FRONT.jpg',
                          url='/api/design-agent/runner/files/art1', widthPx=6091, heightPx=6070)]
        j = {
            'id': id, 'kind': kind, 'source': 'REJECT', 'attempts': attempts, 'priority': 0,
            'requestText': 'Lý do: Sai chi tiết; Khác: sao trên mũ lệch', 'requestedBy': 'Huong',
            'task': {'key': key, 'status': 'REJECTED', 'readiness': 'LOW', 'orderNumber': '#LIT6262', 'linePosition': 1,
                     'sku': 'DN1710260219-Fleece Zip Hoodie', 'designCode': 'DN1710260219', 'supplierSku': 'WZIP-XL',
                     'supplierId': 'sup1', 'productTitle': 'Hoodie', 'variantTitle': 'XL',
                     'imageUrl': 'https://example.com/a.jpg', 'customFields': {'Custom Name Yes or No': 'No'},
                     'sent': False, 'driveFolderUrl': '', 'templateId': 'tpl1'},
            'files': files, 'events': [], 'affected': [], 'parent': None,
        }
        j.update(over)
        return j
    return job


@pytest.fixture
def env_file(tmp_path, monkeypatch, _home):
    def make(server, **over):
        project, builder, codex = tmp_path / 'project', tmp_path / 'builder', tmp_path / 'codex.exe'
        values = {'ECOM_URL': server.url, 'DESIGN_AGENT_TOKEN': server.token, 'PROJECT_DIR': str(project),
                  'ARTWORK_BUILDER': str(builder), 'CODEX_BIN': str(codex)}
        values.update(over)
        if values.get('PROJECT_DIR') == str(project):
            project.mkdir(exist_ok=True)
            (project / 'CLAUDE.md').write_text('# test project\n', encoding='utf-8')
        if values.get('ARTWORK_BUILDER') == str(builder):
            builder.mkdir(exist_ok=True)
        if values.get('CODEX_BIN') == str(codex) and not codex.exists():
            codex.write_bytes(b'')
        path = _home / 'runner.env'
        path.write_text('\n'.join(f'{k}={v}' for k, v in values.items() if v is not None) + '\n', encoding='utf-8')
        monkeypatch.setenv('DESIGN_AGENT_ENV', str(path))
        return path
    return make


@pytest.fixture
def cfg(server, env_file):
    import runner
    return runner.load_config(env_file(server))


@pytest.fixture
def deps(env_file, monkeypatch):
    def make(server, mode, **over):
        import agent_api
        import runner
        env = over.pop('env', {})
        upper = {k: over.pop(k) for k in list(over) if k.isupper()}
        cfg = runner.load_config(env_file(server, **upper))
        monkeypatch.setenv('FAKE_CLAUDE_MODE', mode)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        fields = {'claude_cmd': [sys.executable, str(HERE / 'fake_claude.py')]}
        fields.update(over)
        return runner.Deps(cfg, agent_api.AgentApi(cfg.ecom_url, cfg.token), runner.Log(agent_api.home(), [cfg.token]), **fields)
    return make


@pytest.fixture
def run(deps, job):
    def go(server, mode, **over):
        import threading
        import runner
        job_over = over.pop('job', {})
        return runner.run_job(job(**job_over), deps(server, mode, **over), threading.Event())
    return go
