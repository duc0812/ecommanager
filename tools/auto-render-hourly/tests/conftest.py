import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
TESTS = os.path.dirname(os.path.abspath(__file__))
if TESTS not in sys.path:
    sys.path.insert(0, TESTS)


def gradient(w, h, alpha=255):
    xs = np.linspace(0, 255, w, dtype=np.float32)[None, :]
    ys = np.linspace(0, 255, h, dtype=np.float32)[:, None]
    a = np.zeros((h, w, 4), np.uint8)
    a[..., 0] = (xs * 0.6 + ys * 0.4).astype(np.uint8)
    a[..., 1] = (255 - xs * 0.5 - ys * 0.3).astype(np.uint8)
    a[..., 2] = ((xs + ys) / 2).astype(np.uint8)
    a[..., 3] = alpha
    return Image.fromarray(a, 'RGBA')


def make_piece(base_path: Path, render_path: Path, ink=None, shade=0, size=(600, 400)):
    """A non-flat RGBA base and the same base with a black rectangle at `ink` (or darkened by `shade` levels)."""
    base = gradient(*size)
    base_path.parent.mkdir(parents=True, exist_ok=True)
    render_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(base_path)
    a = np.asarray(base).copy()
    if ink:
        x0, y0, x1, y1 = ink
        if shade:
            a[y0:y1, x0:x1, :3] = np.clip(a[y0:y1, x0:x1, :3].astype(np.int16) - shade, 0, 255).astype(np.uint8)
        else:
            a[y0:y1, x0:x1, :3] = 0
    Image.fromarray(a, 'RGBA').save(render_path)
    return render_path, base_path


# ---------------------------------------------------------------- flat-text: a stand-in for g5/tools/name_render.py

FAKE_NAME_RENDER = r'''
"""Stand-in for artwork-builder/g5/tools/name_render.py: the three entry points the guard uses."""
import json
import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def render_text(t, value, spec_dir):
    w, h = t['_ink']
    core = Image.new('RGBA', (int(w), int(h)), (0, 0, 0, 255))
    if not t.get('glow'):
        return core
    halo = Image.new('RGBA', (core.width + 60, core.height + 60), (0, 0, 0, 40))
    halo.paste(core, (30, 30))
    return halo


def place(sheet, t, layer):
    x0, y0, x1, y1 = t['box']
    bw, bh = x1 - x0, y1 - y0
    sheet.alpha_composite(layer, (x0 + (bw - layer.width) // 2 + t.get('_dx', 0), y0 + (bh - layer.height) // 2 + t.get('_dy', 0)))


def render(spec_path, values, out_dir, line):
    spec_path = Path(spec_path)
    spec_dir = spec_path.parent
    spec = json.loads(spec_path.read_text(encoding='utf-8-sig'))
    outs = []
    for area in spec['areas']:
        texts = [t for t in spec['texts'] if t['area'] == area['printArea']]
        named = any(values.get(t['field'], t.get('fallback', '')).strip() for t in texts)
        sheet = Image.open(spec_dir / (area['base'] if named else area.get('baseNoName', area['base']))).convert('RGBA')
        for t in texts:
            value = values.get(t['field'], t.get('fallback', '')).strip()
            if value:
                place(sheet, t, render_text(t, value.upper() if t.get('upper') else value, spec_dir))
        out = Path(out_dir) / line / f"{line} - {area['printArea']}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out)
        outs.append(out)
    return outs


if __name__ == '__main__':
    a = sys.argv[1:]
    vals = dict(x.split('=', 1) for x in a[3:])
    for o in render(a[0], vals, a[1], a[2]):
        print('saved', o)
'''


def write_fake_name_render(tools_dir: Path) -> Path:
    tools_dir.mkdir(parents=True, exist_ok=True)
    (tools_dir / 'name_render.py').write_text(FAKE_NAME_RENDER, encoding='utf-8')
    return tools_dir


@pytest.fixture
def fake_tools(tmp_path):
    return write_fake_name_render(tmp_path / 'g5tools')


def write_flat_spec(folder: Path, texts, **spec_keys) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    gradient(1000, 800).convert('RGB').save(folder / 'base_FRONT.png')
    spec = {'design': spec_keys.pop('design', 'TN1'), 'dpi': 200, 'areas': [{'printArea': 'FRONT', 'base': 'base_FRONT.png'}],
            'texts': texts, **spec_keys}
    (folder / 'spec.json').write_text(json.dumps(spec), encoding='utf-8')
    return folder / 'spec.json'


@pytest.fixture
def flat_spec(tmp_path):
    def make(_tmp, texts, **spec_keys):
        return write_flat_spec(tmp_path / 'spec', texts, **spec_keys)
    return make


def render_with(tools_dir: Path, spec: Path, out: Path, key: str, values: dict) -> list[dict]:
    """Runs the stand-in CLI as flat_text_batch.py does and returns the group's files; a renderer crash gives []."""
    shutil.rmtree(out / key, ignore_errors=True)
    args = [f'{k}={v}' for k, v in values.items()] or ['_=_']
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8'}
    subprocess.run([sys.executable, str(tools_dir / 'name_render.py'), str(spec), str(out), key, *args], capture_output=True, env=env)
    files = []
    for f in (sorted((out / key).glob(f'{key} - *')) if (out / key).exists() else []):
        w, h = Image.open(f).size
        files.append({'printArea': f.stem.split(' - ', 1)[1], 'path': f.relative_to(out).as_posix(), 'widthPx': w, 'heightPx': h})
    return files


@pytest.fixture
def render(tmp_path, fake_tools):
    def run(spec, key, **values):
        return render_with(fake_tools, spec, tmp_path / '_out', key, values)
    return run


# ---------------------------------------------------------------- auto_render: config, home, a fake PC

LOGIN_EMAIL, LOGIN_PASS = 'local@example.test', 'local-pass'


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTO_RENDER_HOME', str(tmp_path / 'home'))
    monkeypatch.setenv('ARTWORK_WORKER_CACHE', str(tmp_path / 'worker-cache'))
    monkeypatch.delenv('DESIGN_STORAGE_DIR', raising=False)
    monkeypatch.setenv('PYTHONDONTWRITEBYTECODE', '1')


def _touch(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_bytes(b'')


@pytest.fixture
def cfg_file(tmp_path):
    def make(**overrides) -> Path:
        tw, main, ab = tmp_path / 'tool-worktree', tmp_path / 'main-checkout', tmp_path / 'artwork-builder'
        for s in ('process-new-orders.mjs', 'push-local-renders.mjs', 'push-shared-prints.mjs'):
            _touch(tw / 'scripts' / s)
        _touch(tw / 'node_modules' / 'next' / 'dist' / 'bin' / 'next')
        _touch(ab / 'g5' / 'tools' / 'name_render.py')
        _touch(main / 'dev.db')
        (main / 'db-backups').mkdir(parents=True, exist_ok=True)
        login = main / '.superpowers' / 'local' / 'local-login.txt'
        login.parent.mkdir(parents=True, exist_ok=True)
        login.write_text(f'{LOGIN_EMAIL}\n{LOGIN_PASS}\n', encoding='utf-8')
        keys = {'TOOL_WORKTREE': str(tw), 'MAIN_CHECKOUT': str(main), 'ARTWORK_BUILDER': str(ab)}
        keys.update(overrides)
        lines = ['# auto render test config'] + [f'{k}="{v}"' for k, v in keys.items() if v is not None]
        path = tmp_path / 'config.env'
        path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        return path
    return make


FAKE_NODE = Path(TESTS) / 'fake_node.py'


@pytest.fixture
def cfg(cfg_file):
    import auto_render as ar
    c = ar.load_config(cfg_file())
    c.node = [sys.executable, str(FAKE_NODE)]
    c.python = sys.executable
    return c


def pid_alive(pid: int) -> bool:
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


class FakeNode:
    def __init__(self, d: Path):
        self.dir = d

    def plan(self, **kw):
        (self.dir / 'plan.json').write_text(json.dumps(kw), encoding='utf-8')
        calls = self.dir / 'calls.jsonl'
        if calls.exists():
            calls.unlink()

    def calls(self) -> list[dict]:
        p = self.dir / 'calls.jsonl'
        return [json.loads(l) for l in p.read_text(encoding='utf-8').splitlines() if l.strip()] if p.exists() else []


@pytest.fixture
def fake_node(tmp_path, monkeypatch):
    d = tmp_path / 'fake-node'
    d.mkdir()
    monkeypatch.setenv('FAKE_NODE_DIR', str(d))
    monkeypatch.setenv('FAKE_MAIN_CHECKOUT', str(tmp_path / 'main-checkout'))
    yield FakeNode(d)
    pid_file = d / 'tool.pid'
    if pid_file.exists():
        try:
            os.kill(int(pid_file.read_text()), 9)
        except OSError:
            pass


@pytest.fixture
def free_port():
    import socket
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Server:
    def __init__(self, handler_cls):
        from http.server import ThreadingHTTPServer
        import threading
        self.paths, self.bodies = [], []
        handler_cls.server_ref = self
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler_cls)
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _handler(answer):
    from http.server import BaseHTTPRequestHandler

    class H(BaseHTTPRequestHandler):
        server_ref = None

        def _go(self):
            n = int(self.headers.get('content-length') or 0)
            body = self.rfile.read(n) if n else b''
            self.server_ref.paths.append(self.path)
            status, headers, payload = answer(self, body)
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            data = json.dumps(payload).encode()
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = _go

        def log_message(self, *a):
            pass
    return H


@pytest.fixture
def local_tool():
    servers = []

    def make(tasks_status=200, login_status=200):
        def answer(req, body):
            if req.path == '/api/auth/login':
                if req.command != 'POST':
                    return 405, {}, {'error': 'method'}
                req.server_ref.bodies.append(json.loads(body or b'{}'))
                return login_status, ({'set-cookie': 'session=abc; Path=/'} if login_status < 300 else {}), {'ok': login_status < 300}
            if req.path.startswith('/api/design-studio/tasks/'):
                if 'session=abc' not in (req.headers.get('cookie') or ''):
                    return 401, {}, {'error': 'unauthorized'}
                return tasks_status, {}, {'task': req.path.rsplit('/', 1)[1]}
            return 404, {}, {'error': 'not found'}
        s = _Server(_handler(answer))
        servers.append(s)
        return s
    yield make
    for s in servers:
        s.close()


@pytest.fixture
def agent_server():
    servers = []

    def make(token='dag_test', job_id='job-1'):
        def answer(req, body):
            if req.path != '/api/design-agent/runner/hold' or req.command != 'POST':
                return 404, {}, {'error': 'not found'}
            if req.headers.get('authorization') != f'Bearer {token}':
                return 401, {}, {'error': 'unauthorized'}
            req.server_ref.holds.append(json.loads(body))
            return 200, {}, {'ok': True, 'jobId': req.server_ref.job_id}
        s = _Server(_handler(answer))
        s.holds = []
        s.job_id = job_id
        servers.append(s)
        return s
    yield make
    for s in servers:
        s.close()


@pytest.fixture
def local_db(tmp_path):
    import sqlite3
    n = [0]

    def make(tasks=()):
        n[0] += 1
        p = tmp_path / f'local-{n[0]}.db'
        c = sqlite3.connect(p)
        c.execute('CREATE TABLE DesignTask (taskKey TEXT, createdAt TEXT)')
        for i, k in enumerate(tasks):
            c.execute('INSERT INTO DesignTask VALUES (?, ?)', (k, f'2026-11-12T09:00:{i:02d}.000+00:00'))
        c.commit()
        c.close()
        return p
    return make


# ---------------------------------------------------------------- dev.db + prod snapshot with only the columns the run reads

SCHEMA = '''
CREATE TABLE DesignTask (id TEXT, orderId TEXT, shopifyLineId TEXT, taskKey TEXT, status TEXT, readiness TEXT, createdAt TEXT);
CREATE TABLE "Order" (id TEXT, storeId TEXT, placedAt TEXT);
CREATE TABLE OrderLine (orderId TEXT, shopifyLineId TEXT, sku TEXT, resolvedSupplierSku TEXT, resolvedSupplierId TEXT, variantTitle TEXT,
  shopifyProductId TEXT, customallFieldsJson TEXT, customAttributesJson TEXT);
CREATE TABLE DesignArtwork (id TEXT, orderId TEXT, shopifyLineId TEXT, kind TEXT, printArea TEXT, version INTEGER, fileName TEXT,
  storagePath TEXT, source TEXT, removedAt TEXT, createdAt TEXT, widthPx INTEGER, heightPx INTEGER, entryId TEXT, pieceId TEXT);
CREATE TABLE ArtworkEntry (id TEXT, printTemplateId TEXT, artworkFileId TEXT, fields TEXT);
CREATE TABLE ArtworkPiece (id TEXT, entryId TEXT, piece TEXT, artworkFileId TEXT, fields TEXT);
CREATE TABLE LibraryFile (id TEXT, storagePath TEXT, sha256 TEXT);
CREATE TABLE PrintTemplate (id TEXT, supplierId TEXT, supplierSku TEXT, variant TEXT, widthPx INTEGER, heightPx INTEGER, dpi INTEGER,
  safeIn REAL, areas TEXT, pieces TEXT);
'''
WORKER_FIELD = {'field': 'Custom Name', 'area': 'Print', 'box': {'x': 200, 'y': 100, 'w': 205, 'h': 60}}
FLAT_TEXT = {'area': 'FRONT', 'field': 'Custom Name', 'box': [300, 300, 700, 380], '_ink': [200, 60]}
SNAP_NAME = 'prod-snap-20261112-0900.db'


def _num(key):
    import re
    return re.match(r'\D*(\d+)', key).group(1)


def build_dbs(cfg, snapshot: Path, lines: list[dict]):
    """Writes <MAIN_CHECKOUT>/dev.db, the snapshot and the render files of `lines` into <MAIN_CHECKOUT>/storage."""
    import sqlite3
    storage = cfg.main_checkout / 'storage'
    for p in (cfg.main_checkout / 'dev.db', snapshot):
        if p.exists():
            p.unlink()
        p.parent.mkdir(parents=True, exist_ok=True)
    local, prod = sqlite3.connect(cfg.main_checkout / 'dev.db'), sqlite3.connect(snapshot)
    for c in (local, prod):
        c.executescript(SCHEMA)
    local.execute("INSERT INTO PrintTemplate VALUES ('tpl1','sup1','PRINT-1','',600,400,150,0.2,?, '[]')",
                  (json.dumps([{'name': 'Print', 'x': 0, 'y': 0, 'w': 600, 'h': 400}]),))
    local.execute("INSERT INTO ArtworkEntry VALUES ('e1','tpl1','lf1',?)", (json.dumps([WORKER_FIELD]),))
    local.execute("INSERT INTO LibraryFile VALUES ('lf1','library/e1/artwork.png','abc123')")
    prod.execute("INSERT INTO PrintTemplate VALUES ('ptpl','sup1','M-15','',4500,4200,150,0.2,'[]',NULL)")
    for i, ln in enumerate(lines):
        key, n = ln['key'], _num(ln['key'])
        oid, lid = f'o{n}', f'l{key}'
        pairs = [{'key': k, 'value': v} for k, v in ln.get('pairs', [])]
        prod.execute('INSERT INTO DesignTask VALUES (?,?,?,?,?,?,?)', (f'pt{i}', oid, lid, key, ln.get('status', 'NEW'), ln['readiness'], '2026-11-12T08:00:00.000+00:00'))
        prod.execute('INSERT INTO "Order" VALUES (?,?,?)', (oid, 'store1', '2026-11-11T10:00:00.000+00:00'))
        prod.execute('INSERT INTO OrderLine VALUES (?,?,?,?,?,?,?,?,?)', (oid, lid, ln.get('sku', 'TN1-M-15X14INCH'), ln.get('supplierSku', 'M-15'),
                     'sup1', ln.get('variant', 'M'), 'prod1', json.dumps(pairs), '[]'))
        for j in range(ln.get('prodPrints', 0)):
            prod.execute("INSERT INTO DesignArtwork (id, orderId, shopifyLineId, kind, printArea, removedAt) VALUES (?,?,?,'PRINT','Print',NULL)", (f'pa{i}{j}', oid, lid))
        if 'ink' in ln or 'fileName' in ln:
            rel = f'design/{key}/Print/v1.png'
            make_piece(storage / 'library' / 'e1' / 'artwork.png', storage / rel, ink=ln.get('ink'))
            local.execute('INSERT INTO DesignTask VALUES (?,?,?,?,?,?,?)', (f'lt{i}', oid, lid, key, 'REVIEW', ln['readiness'], f'2026-11-12T09:00:{i:02d}.000+00:00'))
            local.execute('INSERT INTO "Order" VALUES (?,?,?)', (oid, 'store1', '2026-11-11T10:00:00.000+00:00'))
            local.execute("INSERT INTO DesignArtwork VALUES (?,?,?,'PRINT','Print',1,?,?,'AUTO',NULL,?,600,400,?,NULL)",
                          (f'a{i}', oid, lid, ln.get('fileName', f'{n}_1_Print_auto.png'), rel, '2026-11-12T09:30:00.000+00:00',
                           ln.get('entryId', 'e1')))
    for c in (local, prod):
        c.commit()
        c.close()


@pytest.fixture
def make_dbs(cfg):
    import auto_render as ar

    def make(tmp_path, lines, shared=None):
        snap = cfg.main_checkout / 'db-backups' / SNAP_NAME
        build_dbs(cfg, snap, lines)
        out = tmp_path / 'out'
        out.mkdir(parents=True, exist_ok=True)
        spec = None
        if shared is not None:
            spec = out / 'spec-shared.json'
            spec.write_text(json.dumps(shared), encoding='utf-8')
        return ar.ProcessResult(snap, out, spec if shared and shared.get('groups') else None, None, None)
    return make


def build_flat(cfg, specs: dict, done: list[dict]):
    """Spec folders in <ARTWORK_BUILDER>/flat-text, the stand-in renderer in g5/tools, the done lines rendered into flat-text/_out."""
    tools = write_fake_name_render(cfg.artwork_builder / 'g5' / 'tools')
    root = cfg.artwork_builder / 'flat-text'
    paths = [write_flat_spec(root / name, [dict(FLAT_TEXT)], **keys) for name, keys in (specs or {'TN1-M': dict(design='TN1', supplierSku='M-15')}).items()]
    out = root / '_out'
    groups = [{'source': d['key'], 'message': 'flat', 'lines': [d['key']], 'files': render_with(tools, paths[0], out, d['key'], d.get('values', {}))}
              for d in done]
    spec_push = out / 'spec_push_test.json'
    spec_push.parent.mkdir(parents=True, exist_ok=True)
    spec_push.write_text(json.dumps({'groups': groups}), encoding='utf-8')
    flat = {'done': [[d['key'], 'TN1', d.get('values', {})] for d in done], 'skipped': [], 'spec': str(spec_push)}
    return flat, spec_push


@pytest.fixture
def flat_run(cfg, tmp_path):
    import auto_render as ar

    def make(specs, done):
        snap = cfg.main_checkout / 'db-backups' / SNAP_NAME
        build_dbs(cfg, snap, done)
        flat, spec_push = build_flat(cfg, specs, done)
        return ar.ProcessResult(snap, tmp_path / 'out', None, flat, spec_push)
    return make


@pytest.fixture
def write_spec(tmp_path):
    def make(name, **keys):
        p = tmp_path / name / 'spec.json'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({'areas': [], 'texts': [], **keys}), encoding='utf-8')
        return p
    return make


# ---------------------------------------------------------------- the whole run on a fake PC

def _dead_pid() -> int:
    p = subprocess.Popen([sys.executable, '-c', 'pass'])
    p.wait()
    return p.pid


DEAD_PID = _dead_pid()


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.slept = 0.0

    def sleep(self, s):
        self.t += s
        self.slept += s

    def now(self):
        return self.t


class World:
    pass


@pytest.fixture
def world(tmp_path, cfg_file, fake_node, local_tool, agent_server, monkeypatch):
    import auto_render as ar
    real_load = ar.load_config

    def load(path):
        c = real_load(path)
        c.node = [sys.executable, str(FAKE_NODE)]
        c.python = sys.executable
        return c
    monkeypatch.setattr(ar, 'load_config', load)
    monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 200.0)

    def make(lines=None, flat=None, hold=False, token='dag_test', push=None):
        w = World()
        w.tool = local_tool()
        w.agent = agent_server(token='dag_test', job_id='job-1')
        keys = {'LOCAL_URL': w.tool.url}
        if hold:
            keys.update(ECOM_URL=w.agent.url, DESIGN_AGENT_TOKEN=token)
        w.config = cfg_file(**keys)
        c = load(w.config)
        w.home, w.node, w.artwork_builder = Path(os.environ['AUTO_RENDER_HOME']), fake_node, c.artwork_builder
        w.snapshot = c.main_checkout / 'db-backups' / SNAP_NAME
        template = tmp_path / 'snap-template.db'
        state = {'lines': list(lines or []), 'flat': list(flat or [])}

        def setup():
            build_dbs(c, template, state['lines'] + [{'sku': 'TN1-M-15X14INCH', 'supplierSku': 'M-15', **f} for f in state['flat']])
            proc = {'snapshot': str(w.snapshot), 'snapshotFrom': str(template)}
            if state['flat']:
                proc['flat'], _ = build_flat(c, None, state['flat'])
            fake_node.plan(process=proc, push=push or {})

        def rerun(lines=None):
            if lines is not None:
                state['lines'] = list(lines)
            setup()

        def summary():
            runs = sorted((w.home / 'logs').glob('run-*.json'), key=lambda p: (p.stat().st_mtime, p.name))
            return json.loads(runs[-1].read_text(encoding='utf-8'))

        def log():
            return '\n'.join(p.read_text(encoding='utf-8') for p in sorted((w.home / 'logs').glob('*.log')))
        w.rerun, w.summary, w.log = rerun, summary, log
        setup()
        return w
    return make
