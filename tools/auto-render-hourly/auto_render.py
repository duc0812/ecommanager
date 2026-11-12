"""Hourly auto render on the shop PC.

One run: mutex -> disk -> local tool -> process-new-orders.mjs (never --push) -> name guards (safe_zone.py) -> push the
passing AUTO lines under artwork-builder/.push-lock -> /hold for the rest -> log + JSON summary. The existing scripts are
only called; what they produced is read back from their own files. Paths come from %USERPROFILE%\\.auto-render\\config.env.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

EXIT_OK, EXIT_STAGE, EXIT_CONFIG, EXIT_DISK = 0, 1, 2, 3
MUTEX_NAME = r'Local\EcomManagerAutoRenderHourly'
DISK_FLOOR_GB = 30
RETAIN_DAYS = 30
ERROR_ALREADY_EXISTS = 183


def home() -> Path:
    h = os.environ.get('AUTO_RENDER_HOME')
    if h:
        return Path(h)
    return Path(os.environ.get('USERPROFILE') or Path.home()) / '.auto-render'


class ConfigError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Config:
    tool_worktree: Path
    main_checkout: Path
    artwork_builder: Path
    local_url: str = 'http://localhost:3013'
    ecom_url: str = ''
    design_agent_token: str = ''
    since_days: int = 14
    box_tolerance_px: float = 3
    node: list[str] = field(default_factory=lambda: ['node'])
    python: str = sys.executable


def _read_env(path: Path) -> dict[str, str]:
    out = {}
    for raw in path.read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        out[k.strip()] = v
    return out


def load_config(path: Path) -> Config:
    path = Path(path)
    if not path.exists():
        raise ConfigError(f'thiếu file cấu hình {path}')
    env = _read_env(path)
    for key in ('TOOL_WORKTREE', 'MAIN_CHECKOUT', 'ARTWORK_BUILDER'):
        if not env.get(key):
            raise ConfigError(f'thiếu {key} trong {path}')
    cfg = Config(Path(env['TOOL_WORKTREE']), Path(env['MAIN_CHECKOUT']), Path(env['ARTWORK_BUILDER']))
    cfg.local_url = (env.get('LOCAL_URL') or cfg.local_url).rstrip('/')
    cfg.ecom_url = (env.get('ECOM_URL') or '').rstrip('/')
    cfg.design_agent_token = env.get('DESIGN_AGENT_TOKEN') or ''
    try:
        if env.get('SINCE_DAYS'):
            cfg.since_days = int(env['SINCE_DAYS'])
        if env.get('NAME_BOX_TOLERANCE_PX'):
            cfg.box_tolerance_px = float(env['NAME_BOX_TOLERANCE_PX'])
    except ValueError as e:
        raise ConfigError(f'giá trị số sai trong {path}: {e}')
    if cfg.ecom_url and not re.match(r'^(https://|http://localhost[:/]|http://127\.0\.0\.1[:/])', cfg.ecom_url + '/'):
        raise ConfigError(f'ECOM_URL phải là https://… (hoặc http://localhost) trong {path}')
    required = [cfg.tool_worktree / 'scripts' / 'process-new-orders.mjs', cfg.tool_worktree / 'scripts' / 'push-local-renders.mjs',
                cfg.tool_worktree / 'scripts' / 'push-shared-prints.mjs', cfg.tool_worktree / 'node_modules' / 'next' / 'dist' / 'bin' / 'next',
                cfg.artwork_builder / 'g5' / 'tools' / 'name_render.py', cfg.main_checkout / 'dev.db']
    for p in required:
        if not p.exists():
            raise ConfigError(f'không thấy {p}')
    return cfg


# ---------------------------------------------------------------- mutex, disk

def _kernel32():
    from ctypes import wintypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    k32.CreateMutexW.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    return k32


def acquire_mutex(name: str = MUTEX_NAME) -> int | None:
    k32 = _kernel32()
    handle = k32.CreateMutexW(None, False, name)
    err = ctypes.get_last_error()
    if not handle:
        raise OSError(f'CreateMutexW lỗi {err}')
    if err == ERROR_ALREADY_EXISTS:
        k32.CloseHandle(handle)
        return None
    return handle


def release_mutex(handle: int) -> None:
    if handle:
        _kernel32().CloseHandle(handle)


def disk_free_gb(path: str = 'D:\\', usage=shutil.disk_usage) -> float:
    return usage(path).free / 1024 ** 3


# ---------------------------------------------------------------- log, summary, retention

def mask(text: str, secrets) -> str:
    for s in secrets or ():
        if s:
            text = text.replace(s, '***')
    return text


class RunLog:
    def __init__(self, home: Path, now: datetime, secrets: list[str] = ()):
        self.home = Path(home)
        self.now = now
        self.secrets = [s for s in secrets if s]
        self.path = self.home / 'logs' / f'{now:%Y-%m-%d}.log'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, 'a', encoding='utf-8'):
            pass

    def _write(self, text: str):
        with open(self.path, 'a', encoding='utf-8') as fh:
            fh.write(text + '\n')
        try:
            print(text, flush=True)
        except UnicodeEncodeError:
            enc = getattr(sys.stdout, 'encoding', None) or 'ascii'
            print(text.encode(enc, 'replace').decode(enc, 'replace'), flush=True)

    def line(self, text: str):
        self._write(f'[{datetime.now():%H:%M:%S}] {mask(str(text), self.secrets)}')

    def block(self, stage: str, text: str):
        body = mask(str(text or ''), self.secrets)
        lines = body.splitlines()
        if lines:
            self._write('\n'.join(f'  {stage}| {l}' for l in lines))


def new_summary(now: datetime, dry_run: bool, since: str | None) -> dict:
    return {'startedAt': now.isoformat(timespec='seconds'), 'finishedAt': None, 'dryRun': bool(dry_run), 'exitCode': None,
            'since': since, 'snapshot': None, 'rendered': [], 'pushed': [], 'held': [], 'notAuto': [], 'unchecked': [],
            'skipped': [], 'errors': []}


def write_summary(home: Path, summary: dict, now: datetime) -> Path:
    p = Path(home) / 'logs' / f'run-{now:%Y%m%d-%H%M%S}.json'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    return p


def prune(home: Path, now: datetime, days: int = RETAIN_DAYS) -> int:
    logs = Path(home) / 'logs'
    if not logs.exists():
        return 0
    cutoff = (now - timedelta(days=days)).timestamp()
    n = 0
    for p in [*logs.glob('*.log'), *logs.glob('run-*.json')]:
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            pass
    return n


# ---------------------------------------------------------------- the local tool and process-new-orders

TOOL_WAIT_S = 120
TOOL_POLL_S = 3
PROCESS_TIMEOUT_S = 1800
SNAPSHOT_NAME = re.compile(r'^prod-snap-\d{8}-\d{4,6}\.db$')


class StageError(Exception):
    def __init__(self, stage: str, message: str, task_key: str | None = None):
        super().__init__(message)
        self.stage = stage
        self.message = message
        self.task_key = task_key


def _session():
    import requests
    s = requests.Session()
    s.trust_env = False
    return s


def tool_reachable(url: str, timeout: float = 5) -> bool:
    import requests
    try:
        _session().get(f'{url.rstrip("/")}/api/auth/login', timeout=timeout, allow_redirects=False)
        return True
    except requests.RequestException:
        return False


def start_tool(cfg: Config, log: RunLog) -> None:
    import subprocess
    from urllib.parse import urlparse
    port = urlparse(cfg.local_url).port or 80
    out = log.home / 'logs' / f'tool-{datetime.now():%Y-%m-%d}.log'
    out.parent.mkdir(parents=True, exist_ok=True)
    flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    with open(out, 'ab') as fh:
        subprocess.Popen(cfg.node + ['node_modules/next/dist/bin/next', 'dev', '--port', str(port)], cwd=str(cfg.tool_worktree),
                         stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    log.line(f'đã khởi động tool local (next dev --port {port}) trong {cfg.tool_worktree}, log {out}')
    deadline = time.monotonic() + TOOL_WAIT_S
    while time.monotonic() < deadline:
        if tool_reachable(cfg.local_url):
            log.line('tool local đã lên')
            return
        time.sleep(TOOL_POLL_S)
    raise StageError('tool', f'tool local không lên sau {TOOL_WAIT_S} giây')


def _ro(db: Path):
    import sqlite3
    return sqlite3.connect(f'file:{Path(db).resolve().as_posix()}?mode=ro', uri=True)


def known_task(local_db: Path) -> str | None:
    c = _ro(local_db)
    try:
        row = c.execute('SELECT taskKey FROM DesignTask ORDER BY createdAt DESC LIMIT 1').fetchone()
    finally:
        c.close()
    return row[0] if row else None


def ensure_tool(cfg: Config, log: RunLog, local_db: Path) -> None:
    import requests
    import sqlite3
    url = cfg.local_url.rstrip('/')
    if not tool_reachable(url):
        log.line(f'tool local {url} không trả lời — khởi động')
        start_tool(cfg, log)
    creds = cfg.main_checkout / '.superpowers' / 'local' / 'local-login.txt'
    if not creds.exists():
        raise StageError('tool', f'không thấy file đăng nhập tool local {creds}')
    parts = [s.strip() for s in creds.read_text(encoding='utf-8-sig').split('\n')]
    email, password = parts[0], (parts[1] if len(parts) > 1 else '')
    if password:
        log.secrets.append(password)
    s = _session()
    try:
        r = s.post(f'{url}/api/auth/login', json={'email': email, 'password': password}, timeout=(10, 60), allow_redirects=False)
    except requests.RequestException as e:
        raise StageError('tool', f'tool local không trả lời khi đăng nhập ({type(e).__name__})')
    if not 200 <= r.status_code < 300:
        raise StageError('tool', f'tool local lỗi {r.status_code}')
    try:
        key = known_task(local_db)
    except sqlite3.Error as e:
        raise StageError('tool', f'không đọc được dev.db local: {e}')
    if not key:
        log.line('chưa có task local để thử')
        return
    try:
        r = s.get(f'{url}/api/design-studio/tasks/{key}', timeout=(10, 180), allow_redirects=False)
    except requests.RequestException as e:
        raise StageError('tool', f'tool local không trả lời ({type(e).__name__})')
    if not 200 <= r.status_code < 300:
        raise StageError('tool', f'tool local lỗi {r.status_code}')
    log.line(f'tool local ổn (task {key} trả {r.status_code})')


@dataclass
class ProcessResult:
    snapshot: Path
    out_dir: Path
    shared_spec: Path | None
    flat: dict | None
    flat_spec: Path | None


def _kill_tree(pid: int) -> None:
    import subprocess
    subprocess.run(['taskkill', '/T', '/F', '/PID', str(pid)], capture_output=True)


def _run(cmd: list[str], cwd: Path, timeout_s: float | None, env_extra: dict | None = None):
    """(exit code or None on timeout, decoded output)."""
    import subprocess
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', **(env_extra or {})}
    p = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
    try:
        out, _ = p.communicate(timeout=timeout_s)
        return p.returncode, out.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired:
        _kill_tree(p.pid)
        try:
            out, _ = p.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            p.kill()
            out = b''
        return None, (out or b'').decode('utf-8', 'replace')


def _has_groups(p: Path) -> bool:
    try:
        return bool(json.loads(Path(p).read_text(encoding='utf-8-sig')).get('groups'))
    except (OSError, ValueError, AttributeError):
        return False


def run_process_new_orders(cfg: Config, since: str, out_dir: Path, log: RunLog, timeout_s: float = PROCESS_TIMEOUT_S) -> ProcessResult:
    import math
    cmd = cfg.node + ['scripts/process-new-orders.mjs', '--since', since, '--url', cfg.local_url, '--out', str(out_dir)]
    log.line(f'chạy process-new-orders --since {since} (không --push)')
    code, out = _run(cmd, cfg.tool_worktree, timeout_s)
    log.block('process', out)
    snap = None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('snapshot '):
            snap = Path(line[len('snapshot '):].strip())
    if code is None or code != 0:
        e = StageError('process', f'process-new-orders quá {math.ceil(timeout_s / 60)} phút' if code is None else f'process-new-orders thoát mã {code}')
        e.snapshot = snap  # printed by this run's own freshSnapshot(): ours to drop
        raise e
    if snap is None or not snap.exists():
        raise StageError('process', 'không xác định được snapshot của lần chạy')
    shared = Path(out_dir) / 'spec-shared.json'
    flat_json = Path(out_dir) / 'flat-text.json'
    flat = None
    if flat_json.exists():
        try:
            flat = json.loads(flat_json.read_text(encoding='utf-8-sig'))
        except ValueError:
            raise StageError('process', 'flat-text.json của lần chạy lỗi')
    flat_spec = Path(flat['spec']) if flat and flat.get('spec') and _has_groups(Path(flat['spec'])) else None
    return ProcessResult(snap, Path(out_dir), shared if _has_groups(shared) else None, flat, flat_spec)


def since_date(now: datetime, days: int) -> str:
    return (now - timedelta(days=days)).strftime('%Y-%m-%d')


def drop_own_snapshot(cfg: Config, snapshot: Path, log: RunLog) -> bool:
    snapshot = Path(snapshot)
    if not SNAPSHOT_NAME.match(snapshot.name):
        return False
    if snapshot.parent.resolve() != (cfg.main_checkout / 'db-backups').resolve():
        return False
    try:
        snapshot.unlink()
    except FileNotFoundError:
        return False
    log.line(f'đã xoá snapshot của lần chạy {snapshot.name}')
    return True


# ---------------------------------------------------------------- the plan: candidates, guards, filtered specs

import safe_zone as sz  # noqa: E402


@dataclass
class Line:
    key: str
    source: str
    status: str | None
    readiness: str | None
    result: sz.GuardResult


@dataclass
class Plan:
    lines: list[Line]
    push_local: list[str]
    shared_spec: Path | None
    flat_spec: Path | None
    pushable: set[str]
    skipped: list[dict]
    errors: list[dict]


class SpecUnresolved(Exception):
    def __init__(self, count: int):
        super().__init__(f'{count} spec khớp')
        self.count = count


def _pairs(raw: str | None, strip_underscore: bool = False) -> list[tuple[str, str]]:
    try:
        items = json.loads(raw or '[]')
    except ValueError:
        return []
    out = []
    for f in items if isinstance(items, list) else []:
        if isinstance(f, dict):
            k = str(f.get('key', '') or '')
            out.append((k.lstrip('_') if strip_underscore else k, str(f.get('value', '') or '')))
    return out


def read_prod(snapshot: Path) -> dict[str, dict]:
    c = _ro(snapshot)
    try:
        rows = c.execute('''
            SELECT t.taskKey, t.status, t.readiness, l.sku, l.resolvedSupplierId, l.resolvedSupplierSku, l.variantTitle, l.shopifyProductId,
                   o.storeId, l.customallFieldsJson, l.customAttributesJson,
                   (SELECT COUNT(*) FROM DesignArtwork a WHERE a.orderId = t.orderId AND a.shopifyLineId = t.shopifyLineId
                       AND a.kind = 'PRINT' AND a.removedAt IS NULL) AS prints
              FROM DesignTask t JOIN OrderLine l ON l.orderId = t.orderId AND l.shopifyLineId = t.shopifyLineId
              JOIN "Order" o ON o.id = t.orderId''').fetchall()
    finally:
        c.close()
    out = {}
    for key, status, readiness, sku, sup, ssku, variant, product, store, fjson, ajson, prints in rows:
        out[key] = {'status': status, 'readiness': readiness, 'prints': int(prints or 0), 'sku': sku, 'resolvedSupplierId': sup,
                    'resolvedSupplierSku': ssku, 'variantTitle': variant, 'shopifyProductId': product, 'storeId': store,
                    'pairs': _pairs(fjson) + _pairs(ajson, strip_underscore=True)}
    return out


def local_render_files(local_db: Path, since: str) -> dict[str, list[dict]]:
    c = _ro(local_db)
    try:
        rows = c.execute('''
            SELECT t.taskKey, a.printArea, a.version, a.fileName, a.storagePath, a.widthPx, a.heightPx, a.entryId, a.pieceId
              FROM DesignArtwork a JOIN DesignTask t ON t.orderId = a.orderId AND t.shopifyLineId = a.shopifyLineId
             WHERE a.source = 'AUTO' AND a.kind = 'PRINT' AND a.removedAt IS NULL AND a.storagePath IS NOT NULL
               AND a.createdAt >= ? AND t.status = 'REVIEW'
             ORDER BY t.taskKey, a.printArea, a.version''', (since,)).fetchall()
    finally:
        c.close()
    latest: dict[str, dict[str, dict]] = {}
    for key, area, version, name, path, w, h, entry, piece in rows:
        have = latest.setdefault(key, {}).get(area)
        if have is None or int(version) > have['version']:
            latest[key][area] = {'printArea': area, 'version': int(version), 'fileName': name, 'storagePath': path, 'widthPx': w,
                                 'heightPx': h, 'entryId': entry, 'pieceId': piece}
    return {k: [v for _, v in sorted(by.items())] for k, by in latest.items()}


def worker_cache_dir() -> Path:
    env = os.environ.get('ARTWORK_WORKER_CACHE')
    if env:
        return Path(env)
    return Path(os.environ.get('USERPROFILE') or Path.home()) / '.artwork-worker' / 'artwork'


def _json(raw, default):
    try:
        v = json.loads(raw) if raw else default
        return v if v is not None else default
    except (ValueError, TypeError):
        return default


def worker_inputs(local_db: Path, row: dict, storage_root: Path, rules: dict) -> dict:
    c = _ro(local_db)
    try:
        entry = c.execute('SELECT id, printTemplateId, artworkFileId, fields FROM ArtworkEntry WHERE id = ?', (row.get('entryId'),)).fetchone()
        piece = c.execute('SELECT piece, artworkFileId, fields FROM ArtworkPiece WHERE id = ?', (row['pieceId'],)).fetchone() if row.get('pieceId') else None
        file_id = piece[1] if piece else (entry[2] if entry else None)
        lib = c.execute('SELECT storagePath, sha256 FROM LibraryFile WHERE id = ?', (file_id,)).fetchone() if file_id else None
        tpl = c.execute('SELECT dpi, safeIn, areas, pieces, widthPx, heightPx FROM PrintTemplate WHERE id = ?', (entry[1],)).fetchone() if entry else None
    finally:
        c.close()
    fields = _json(piece[2], []) if piece else (_json(entry[3], []) if entry else None)
    base_path = None
    if lib:
        if lib[0] and (Path(storage_root) / lib[0]).exists():
            base_path = Path(storage_root) / lib[0]
        elif lib[1] and (worker_cache_dir() / lib[1]).exists():
            base_path = worker_cache_dir() / lib[1]
    w, h = row.get('widthPx'), row.get('heightPx')
    if not w or not h:
        from PIL import Image
        with Image.open(Path(storage_root) / row['storagePath']) as im:
            w, h = im.size
    area = (0.0, 0.0, float(w), float(h))
    safe_in = dpi = None
    if tpl:
        safe_in, dpi = tpl[1], tpl[0]
        pieces = _json(tpl[3], [])
        name = piece[0] if piece else row['printArea']
        pdef = next((p for p in pieces if p.get('name') == name), None)
        if pdef and pdef.get('dpi'):
            dpi = pdef['dpi']
        if not pieces:
            a = next((a for a in _json(tpl[2], []) if a.get('name') == row['printArea']), None)
            if a:
                area = (float(a['x']), float(a['y']), float(a['x']) + float(a['w']), float(a['y']) + float(a['h']))
    return {'fields': fields, 'base_path': base_path, 'safe_in': safe_in, 'dpi': dpi, 'area': area,
            'photoshop_rule': rules.get(row.get('entryId'))}


def load_photoshop_rules(artwork_builder: Path) -> dict[str, dict]:
    out = {}
    folder = Path(artwork_builder) / 'design-rules'
    for p in sorted(folder.glob('*.json')) if folder.exists() else []:
        try:
            d = json.loads(p.read_text(encoding='utf-8-sig'))
        except (ValueError, OSError):
            raise StageError('guard', f'file quy tắc {p.name} lỗi')
        entries = d.get('entries') if isinstance(d, dict) else None
        for eid, rule in (entries or {}).items() if isinstance(entries, dict) else []:
            if isinstance(rule, dict) and rule.get('renderer') == 'photoshop':
                out[eid] = rule
    return out


def design_of(sku: str) -> str | None:
    if not sku:
        return None
    m = re.search(r'=([A-Za-z0-9]+)$', sku)
    if m:
        return m.group(1)
    return re.split(r'[-\s]', sku.strip())[0]


def _spec_fits(s: dict, key: str, prod: dict) -> bool:
    sku, ssku, variant = prod.get('sku') or '', prod.get('resolvedSupplierSku') or '', prod.get('variantTitle') or ''
    if s.get('shopifyProductId') and s['shopifyProductId'] != prod.get('shopifyProductId'):
        return False
    if s.get('storeId') and s['storeId'] != prod.get('storeId'):
        return False
    if s.get('supplierSku') and not ssku.upper().startswith(s['supplierSku'].upper()):
        return False
    if s.get('skuContains') and s['skuContains'].upper() not in sku.upper():
        return False
    if s.get('skuIs') and s['skuIs'].upper() != sku.strip().upper():
        return False
    if s.get('skuNot') and s['skuNot'].upper() in sku.upper():
        return False
    if s.get('skuEnds') and not sku.strip().upper().endswith(s['skuEnds'].upper()):
        return False
    if s.get('variantContains') and s['variantContains'].upper() not in variant.upper():
        return False
    if s.get('minOrder'):
        m = re.match(r'\D*(\d+)', key)
        if not ((m and int(m.group(1)) >= s['minOrder']) or key in s.get('alsoLines', [])):
            return False
    pairs = prod.get('pairs') or []
    for mk, mv in (s.get('match') or {}).items():
        if not any(str(k).lower().strip().rstrip(':?').strip() == str(mk).lower() and str(v).strip().lower() == str(mv).lower() for k, v in pairs):
            return False
    return True


def resolve_flat_spec(flat_root: Path, key: str, prod: dict) -> Path:
    d = design_of(prod.get('sku') or '')
    hits = []
    for p in sorted(Path(flat_root).glob('*/spec.json')):
        try:
            s = json.loads(p.read_text(encoding='utf-8-sig'))
        except ValueError:
            continue
        if s.get('design') == d and _spec_fits(s, key, prod):
            hits.append(p)
    if len(hits) != 1:
        raise SpecUnresolved(len(hits))
    return hits[0]


def template_safe_in(snapshot: Path, supplier_id, supplier_sku) -> float | None:
    if not supplier_id or not supplier_sku:
        return None
    c = _ro(snapshot)
    try:
        rows = c.execute('SELECT supplierSku, safeIn FROM PrintTemplate WHERE supplierId = ? AND supplierSku IS NOT NULL', (supplier_id,)).fetchall()
    finally:
        c.close()
    want = str(supplier_sku).upper()
    exact = [r for r in rows if str(r[0]).upper() == want]
    if exact:
        return exact[0][1]
    prefix = sorted((r for r in rows if r[0] and want.startswith(str(r[0]).upper())), key=lambda r: len(r[0]), reverse=True)
    return prefix[0][1] if prefix else None


def filter_spec(spec_path: Path, keep: set[str]) -> Path | None:
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding='utf-8-sig'))
    groups = []
    for g in spec.get('groups', []):
        lines = [k for k in g.get('lines', []) if k in keep]
        if lines:
            groups.append({**g, 'lines': lines})
    if not groups:
        return None
    out = spec_path.with_name(spec_path.stem + '.auto.json')
    out.write_text(json.dumps({**spec, 'groups': groups}, ensure_ascii=False, indent=1), encoding='utf-8')
    return out


def _combine(results: list[sz.GuardResult]) -> sz.GuardResult:
    for verdict in ('HOLD', 'ERROR', 'UNCHECKED'):
        for r in results:
            if r.verdict == verdict:
                return r
    return results[0] if results else sz.GuardResult('PASS', None, '', {})


def storage_root(cfg: Config) -> Path:
    return Path(os.environ.get('DESIGN_STORAGE_DIR') or cfg.main_checkout / 'storage')


def _image_size(p: Path) -> tuple[int, int] | None:
    from PIL import Image
    try:
        with Image.open(p) as im:
            return im.size
    except OSError:
        return None


def build_plan(cfg: Config, pr: ProcessResult, since: str, tmp_dir: Path, log: RunLog) -> Plan:
    prod = read_prod(pr.snapshot)
    cands = {k for k, v in prod.items() if v['status'] == 'NEW' and v['prints'] == 0}
    local_db = cfg.main_checkout / 'dev.db'
    root = storage_root(cfg)
    lines: list[Line] = []
    skipped: list[dict] = []
    seen: set[str] = set()

    def add(key, source, result):
        seen.add(key)
        p = prod.get(key, {})
        lines.append(Line(key, source, p.get('status'), p.get('readiness'), result))

    rules = load_photoshop_rules(cfg.artwork_builder)
    for key, rows in sorted(local_render_files(local_db, since).items()):
        if key not in cands:
            continue
        try:
            ins = [worker_inputs(local_db, r, root, rules) for r in rows]
            names = tuple(str(f.get('field')) for i in ins for f in (i['fields'] or []) if isinstance(f, dict) and f.get('field'))
            no = sz.lone_no(prod[key]['pairs'], names)
            results = []
            for r, i in zip(rows, ins):
                if i['fields'] is None:
                    if no and '-noname.' not in r['fileName']:
                        results.append(sz.GuardResult('HOLD', 'NO', 'khách chọn No nhưng file in có tên', {'file': r['fileName']}))
                        continue
                    results.append(sz.GuardResult('UNCHECKED', None, 'không kiểm được safe zone (không có entry thư viện)', {}))
                    continue
                inset = sz.safe_inset_px(i['safe_in'], i['dpi'], None)
                results.append(sz.check_worker_piece(root / r['storagePath'], i['base_path'], i['fields'], r['fileName'], no, i['area'],
                                                     inset, i['photoshop_rule'], cfg.box_tolerance_px))
            add(key, 'local-render', _combine(results))
        except (OSError, ValueError, KeyError) as e:
            add(key, 'local-render', sz.GuardResult('ERROR', None, f'không đo được khung tên: {type(e).__name__}: {e}', {}))

    if pr.flat_spec:
        flat = json.loads(Path(pr.flat_spec).read_text(encoding='utf-8-sig'))
        values_of = {d[0]: (d[2] if len(d) > 2 and d[2] else {}) for d in (pr.flat or {}).get('done', [])}
        flat_root = cfg.artwork_builder / 'flat-text'
        tools_dir = cfg.artwork_builder / 'g5' / 'tools'
        files_root = Path(pr.flat_spec).parent
        for g in flat.get('groups', []):
            for key in g.get('lines', []):
                if key not in cands or key in seen:
                    continue
                p = prod[key]
                try:
                    spec_path = resolve_flat_spec(flat_root, key, p)
                except SpecUnresolved as e:
                    add(key, 'flat-text', sz.GuardResult('ERROR', None, f'không xác định được spec flat-text ({e.count} spec khớp)', {}))
                    continue
                spec = json.loads(spec_path.read_text(encoding='utf-8-sig'))
                text_areas = {t['area'] for t in spec.get('texts', [])}
                mismatch = False
                for a in spec.get('areas', []):
                    if a['printArea'] not in text_areas:
                        continue
                    f = next((f for f in g.get('files', []) if f.get('printArea') == a['printArea'] and (f.get('kind') or 'PRINT') != 'MOCKUP'), None)
                    if not f or not f.get('path'):
                        continue
                    size = (f.get('widthPx'), f.get('heightPx')) if f.get('widthPx') else _image_size(files_root / f['path'])
                    if size and tuple(size) != _image_size(spec_path.parent / a['base']):
                        mismatch = True
                if mismatch:
                    add(key, 'flat-text', sz.GuardResult('ERROR', None, 'spec flat-text không khớp khổ file', {'spec': str(spec_path)}))
                    continue
                safe_in = template_safe_in(pr.snapshot, p.get('resolvedSupplierId'), p.get('resolvedSupplierSku'))
                res = sz.check_flat_line(key, spec_path, values_of.get(key, {}), sz.lone_no(p['pairs']), g.get('files', []), files_root,
                                         safe_in, tools_dir, cfg.python, Path(tmp_dir) / key, cfg.box_tolerance_px)
                add(key, 'flat-text', res)

    if pr.shared_spec:
        shared = json.loads(Path(pr.shared_spec).read_text(encoding='utf-8-sig'))
        for g in shared.get('groups', []):
            cm = any(f.get('path') for f in g.get('files', []))
            for key in g.get('lines', []):
                if key not in cands or key in seen:
                    continue
                if cm:
                    skipped.append({'taskKey': key, 'reason': 'cm-builder: không thuộc auto render hàng giờ'})
                    seen.add(key)
                else:
                    add(key, 'reuse', sz.GuardResult('PASS', None, '', {'files': 'drive'}))

    pushable = {l.key for l in lines if l.readiness == 'AUTO' and l.result.verdict in ('PASS', 'UNCHECKED')}
    push_local = sorted(l.key for l in lines if l.source == 'local-render' and l.key in pushable)
    reuse_keep = {l.key for l in lines if l.source == 'reuse' and l.key in pushable}
    flat_keep = {l.key for l in lines if l.source == 'flat-text' and l.key in pushable}
    errors = [{'stage': 'guard', 'taskKey': l.key, 'message': l.result.reason} for l in lines if l.result.verdict == 'ERROR']
    return Plan(lines, push_local, filter_spec(pr.shared_spec, reuse_keep) if pr.shared_spec else None,
                filter_spec(pr.flat_spec, flat_keep) if pr.flat_spec else None, pushable, skipped, errors)


# ---------------------------------------------------------------- push under .push-lock

RUN_DEADLINE_S = 50 * 60
LOCK_WAIT_S = 1800
PUSH_MIN_LEFT_S = 180
STAGES = ('--apply', '--prove', '--push')


class LockBusy(Exception):
    pass


def pid_alive(pid: int) -> bool:
    from ctypes import wintypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = k32.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        k32.CloseHandle(handle)


def lock_identity(lock_dir: Path) -> tuple[int, int] | None:
    try:
        st = os.stat(lock_dir)
    except OSError:
        return None
    return st.st_ino, st.st_ctime_ns


class PushLock:
    """artwork-builder/.push-lock (mkdir/rmdir). Waits, never breaks another holder's lock; frees only a lock its own marker says
    a dead process of this tool left behind (a run killed by the task's time limit)."""

    def __init__(self, lock_dir: Path, home: Path, wait_s: float = LOCK_WAIT_S, poll_s: float = 10, sleep=time.sleep, clock=time.monotonic):
        self.lock_dir, self.marker = Path(lock_dir), Path(home) / 'push-lock.owner'
        self.wait_s, self.poll_s, self.sleep, self.clock = wait_s, poll_s, sleep, clock
        self.release_error: str | None = None

    def recover(self) -> bool:
        if not self.marker.exists():
            return False
        if not self.lock_dir.exists():
            self.marker.unlink(missing_ok=True)
            return False
        try:
            raw = self.marker.read_text().strip()
            m = json.loads(raw) if raw.startswith('{') else {'pid': int(raw)}
            pid = int(m['pid'])
        except (ValueError, KeyError, TypeError):
            return False
        if pid_alive(pid):
            return False
        # our run is dead; the folder is ours only if it is the very folder that run created
        if (m.get('ino'), m.get('ctimeNs')) != lock_identity(self.lock_dir):
            self.marker.unlink(missing_ok=True)
            return False
        try:
            self.lock_dir.rmdir()
        except OSError:
            return False
        self.marker.unlink(missing_ok=True)
        return True

    def __enter__(self):
        self.recover()
        start = self.clock()
        while True:
            try:
                self.lock_dir.mkdir()
                break
            except FileExistsError:
                if self.clock() - start >= self.wait_s:
                    raise LockBusy(str(self.lock_dir))
                self.sleep(self.poll_s)
        self.marker.parent.mkdir(parents=True, exist_ok=True)
        ino, ctime_ns = lock_identity(self.lock_dir)
        self.marker.write_text(json.dumps({'pid': os.getpid(), 'ino': ino, 'ctimeNs': ctime_ns}))
        return self

    def __exit__(self, *exc):
        self.marker.unlink(missing_ok=True)
        try:
            self.lock_dir.rmdir()
        except FileNotFoundError:
            pass
        except OSError as e:
            self.release_error = f'{type(e).__name__}: {e}'
        return False


def _aware(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
    except ValueError:
        return None
    return d if d.tzinfo else d.astimezone()


def _read_ledger(path: Path) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return {}


def _outcome(ledger: dict, key: str, started: datetime) -> str | None:
    led = (ledger.get('lines') or {}).get(key) or {}
    at = _aware(led.get('applied'))
    st = started if started.tzinfo else started.astimezone()
    if at and at >= st:
        return 'pushed'
    if led.get('skippedOnProd'):
        return f"skipped: {led['skippedOnProd']}"
    return None


def _push_stage(cfg: Config, script: str, args: list[str], stage: str, key: str | None, log: RunLog, timeout_s: float):
    code, out = _run(cfg.node + [f'scripts/{script}.mjs', *args, stage], cfg.tool_worktree, timeout_s)
    log.block(script, out)
    if code is None:
        raise StageError('push', f'{script} {stage} quá giờ của lần chạy', key)
    if code != 0:
        raise StageError('push', f'{script} {stage} thoát mã {code}', key)
    for line in out.splitlines():
        if 'DỪNG:' in line:
            raise StageError('push', line.split('DỪNG:', 1)[1].strip(), key)


def push_local_line(cfg: Config, snapshot: Path, since: str, key: str, started: datetime, log: RunLog, timeout_s: float = 1800) -> str:
    args = ['--snapshot', str(snapshot), '--since', since, '--line', key]
    for st in STAGES:
        _push_stage(cfg, 'push-local-renders', args, st, key, log, timeout_s)
    ledger = _read_ledger(cfg.main_checkout / 'db-backups' / 'push-local-renders' / 'ledger.json')
    got = _outcome(ledger, key, started)
    if got is None:
        raise StageError('push', 'đẩy xong nhưng ledger không ghi nhận dòng', key)
    return got


def push_spec(cfg: Config, spec: Path, snapshot: Path, ledger_dir: Path | None, keys: list[str], started: datetime, log: RunLog,
              timeout_s: float = 1800) -> dict[str, str]:
    args = ['--spec', str(spec), '--snapshot', str(snapshot), *(['--out', str(ledger_dir)] if ledger_dir else [])]
    first = keys[0] if keys else None
    for st in STAGES:
        _push_stage(cfg, 'push-shared-prints', args, st, first, log, timeout_s)
    ledger = _read_ledger((Path(ledger_dir) if ledger_dir else cfg.main_checkout / 'db-backups' / 'push-shared-prints') / 'ledger.json')
    out = {}
    for k in keys:
        got = _outcome(ledger, k, started)
        if got is None:
            raise StageError('push', 'đẩy xong nhưng ledger không ghi nhận dòng', k)
        out[k] = got
    return out


# ---------------------------------------------------------------- /hold

class HoldState:
    def __init__(self, home: Path):
        self.path = Path(home) / 'holds.json'
        self.data = _read_ledger(self.path) if self.path.exists() else {}

    @staticmethod
    def sig(guard: str | None, reason: str) -> str:
        import hashlib
        return hashlib.sha256(f'{guard or ""}|{reason}'.encode('utf-8')).hexdigest()

    def needs_report(self, key: str, guard: str | None, reason: str) -> bool:
        return (self.data.get(key) or {}).get('sig') != self.sig(guard, reason)

    def get(self, key: str) -> dict:
        return self.data.get(key) or {}

    def unanswered(self, key: str) -> bool:
        return key in self.data and self.data[key].get('jobId') is None

    def record(self, key: str, guard: str | None, reason: str, job_id: str | None):
        self.data[key] = {'sig': self.sig(guard, reason), 'reportedAt': datetime.now().isoformat(timespec='seconds'), 'jobId': job_id}
        self._save()

    def forget(self, except_keys):
        keep = set(except_keys)
        gone = [k for k in self.data if k not in keep]
        if gone:
            for k in gone:
                del self.data[k]
            self._save()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding='utf-8')


def post_hold(cfg: Config, key: str, reason: str) -> str | None:
    import requests
    try:
        r = _session().post(f'{cfg.ecom_url.rstrip("/")}/api/design-agent/runner/hold', json={'taskKey': key, 'reason': reason},
                            headers={'Authorization': f'Bearer {cfg.design_agent_token}'}, timeout=(10, 60), allow_redirects=False)
    except requests.RequestException as e:
        raise StageError('hold', f'/hold không gọi được ({type(e).__name__})', key)
    if not 200 <= r.status_code < 300:
        raise StageError('hold', f'/hold trả {r.status_code}', key)
    try:
        return (r.json() or {}).get('jobId')
    except ValueError:
        return None


# ---------------------------------------------------------------- the run

def _err(e: StageError) -> dict:
    d = {'stage': e.stage}
    if e.task_key:
        d['taskKey'] = e.task_key
    d['message'] = e.message
    return d


def _spec_keys(spec: Path) -> list[str]:
    return [k for g in json.loads(Path(spec).read_text(encoding='utf-8-sig')).get('groups', []) for k in g.get('lines', [])]


def run_stages(cfg: Config, log: RunLog, summary: dict, args) -> int:
    import math
    from datetime import timezone
    t0 = time.monotonic()
    left = lambda: RUN_DEADLINE_S - (time.monotonic() - t0)
    started = datetime.now(timezone.utc)
    now = datetime.now()
    since = since_date(now, cfg.since_days)
    summary['since'] = since
    h = log.home
    snapshot = None
    try:
        ensure_tool(cfg, log, cfg.main_checkout / 'dev.db')
        out_dir = cfg.main_checkout / 'db-backups' / 'process-new-orders' / f'auto-{now:%Y%m%d-%H%M%S}'
        pr = run_process_new_orders(cfg, since, out_dir, log, timeout_s=min(PROCESS_TIMEOUT_S, max(60, left() - 600)))
        snapshot = pr.snapshot
        summary['snapshot'] = str(snapshot)
        plan = build_plan(cfg, pr, since, h / 'tmp' / f'{now:%Y%m%d-%H%M%S}', log)
        auto = {l.key for l in plan.lines if l.readiness == 'AUTO'}
        summary['rendered'] = sorted(l.key for l in plan.lines)
        summary['notAuto'] = sorted(l.key for l in plan.lines if l.readiness != 'AUTO')
        summary['held'] = [{'taskKey': l.key, 'source': l.source, 'guard': l.result.guard, 'reason': l.result.reason, 'reported': False, 'jobId': None}
                           for l in sorted(plan.lines, key=lambda l: l.key) if l.key in auto and l.result.verdict == 'HOLD']
        summary['unchecked'] = [{'taskKey': l.key, 'reason': l.result.reason} for l in sorted(plan.lines, key=lambda l: l.key)
                                if l.key in auto and l.result.verdict == 'UNCHECKED']
        summary['skipped'] += plan.skipped
        for e in plan.errors:
            if e['taskKey'] in auto:
                summary['errors'].append(e)
            else:
                log.line(f'dòng không AUTO {e["taskKey"]}: {e["message"]} (không đẩy, không tính lỗi)')
        for l in plan.lines:
            if l.result.verdict != 'PASS':
                log.line(f'{l.key} [{l.source}, {l.readiness}] {l.result.verdict}: {l.result.reason}')
        log.line(f'kế hoạch: {len(plan.lines)} dòng, đẩy được {len(plan.pushable)}, giữ {len(summary["held"])}, '
                 f'không AUTO {len(summary["notAuto"])}, lỗi đo {len(plan.errors)}')
        if args.dry_run:
            log.line(f'[chạy thử] sẽ đẩy: {", ".join(sorted(plan.pushable)) or "không có"}')
        else:
            _push_phase(cfg, log, summary, plan, snapshot, since, started, left)
        _hold_phase(cfg, log, summary, args.dry_run)
    except StageError as e:
        log.line(f'dừng ở bước {e.stage}: {e.message}')
        summary['errors'].append(_err(e))
        if snapshot is None and getattr(e, 'snapshot', None):
            snapshot = e.snapshot
            summary['snapshot'] = str(snapshot)
    finally:
        if snapshot and not args.keep_snapshot:
            drop_own_snapshot(cfg, snapshot, log)
    return EXIT_STAGE if summary['errors'] else EXIT_OK


def _push_phase(cfg, log, summary, plan, snapshot, since, started, left):
    import math
    if not (plan.push_local or plan.shared_spec or plan.flat_spec):
        log.line('không có dòng nào để đẩy')
        return
    wait = max(0.0, min(LOCK_WAIT_S, left() - 300))

    def budget():
        if left() < PUSH_MIN_LEFT_S:
            raise StageError('push', 'hết giờ của lần chạy — phần còn lại để lần sau')
        return max(60.0, left() - 60)

    def note(key, outcome):
        if outcome == 'pushed':
            summary['pushed'].append(key)
            log.line(f'đã đẩy {key} lên prod (REVIEW)')
        else:
            reason = outcome.split(': ', 1)[1] if ': ' in outcome else outcome
            summary['skipped'].append({'taskKey': key, 'reason': reason})
            log.line(f'{key} bị bỏ qua trên prod: {reason}')

    lock = PushLock(cfg.artwork_builder / '.push-lock', log.home, wait_s=wait)
    try:
        with lock:
            for key in plan.push_local:
                note(key, push_local_line(cfg, snapshot, since, key, started, log, timeout_s=budget()))
            for spec, ledger in ((plan.shared_spec, None), (plan.flat_spec, log.home / 'flat-ledger')):
                if spec:
                    res = push_spec(cfg, spec, snapshot, ledger, _spec_keys(spec), started, log, timeout_s=budget())
                    for key, outcome in res.items():
                        note(key, outcome)
    except LockBusy:
        msg = f'khoá .push-lock bận quá {math.ceil(wait / 60)} phút — chưa đẩy, để lần sau'
        log.line(msg)
        summary['errors'].append({'stage': 'lock', 'message': msg})
    except StageError as e:
        log.line(f'dừng đẩy: {e.message}{f" ({e.task_key})" if e.task_key else ""}')
        summary['errors'].append(_err(e))
    if lock.release_error:
        msg = f'KHÔNG nhả được khoá .push-lock của lần chạy này ({lock.release_error}) — cần xoá tay thư mục {lock.lock_dir}'
        log.line(msg)
        summary['errors'].append({'stage': 'lock', 'message': msg})


def _hold_phase(cfg, log, summary, dry_run):
    held = summary['held']
    configured = bool(cfg.ecom_url and cfg.design_agent_token)
    if dry_run:
        for item in held:
            log.line(f'[chạy thử] giữ lại {item["taskKey"]}: {item["reason"]}')
        return
    state = HoldState(log.home)
    try:
        for item in held:
            key, guard, reason = item['taskKey'], item['guard'], item['reason']
            if not configured:
                log.line(f'giữ lại {key}: {reason} (chưa cấu hình /hold — chỉ ghi log)')
                continue
            if state.needs_report(key, guard, reason) or state.unanswered(key):
                job = post_hold(cfg, key, reason)
                state.record(key, guard, reason, job)
                item['reported'], item['jobId'] = True, job
                log.line(f'giữ lại {key}: {reason} — đã báo /hold{f" (job {job})" if job else " (chỉ ghi chú)"}')
            else:
                item['reported'], item['jobId'] = True, state.get(key).get('jobId')
                log.line(f'giữ lại {key}: {reason} — đã báo trước đó')
    except StageError as e:
        log.line(f'dừng báo /hold: {e.message} ({e.task_key})')
        summary['errors'].append(_err(e))
    finally:
        state.forget(item['taskKey'] for item in held)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='Auto render hàng giờ')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--keep-snapshot', action='store_true')
    ap.add_argument('--config', default=None)
    args = ap.parse_args(argv)
    h = home()
    now = datetime.now()
    log = RunLog(h, now)
    summary = new_summary(now, args.dry_run, None)
    cfg_path = Path(args.config) if args.config else h / 'config.env'

    def finish(code: int) -> int:
        summary['finishedAt'] = datetime.now().isoformat(timespec='seconds')
        summary['exitCode'] = code
        write_summary(h, summary, now)
        prune(h, now)
        return code

    try:
        cfg = load_config(cfg_path)
    except ConfigError as e:
        log.line(f'lỗi cấu hình: {e.message}')
        summary['errors'].append({'stage': 'config', 'message': e.message})
        return finish(EXIT_CONFIG)
    log.secrets.append(cfg.design_agent_token)
    log.secrets = [s for s in log.secrets if s]
    handle = acquire_mutex()
    if handle is None:
        log.line('lần chạy trước chưa xong — bỏ qua lần này')
        return EXIT_OK
    try:
        free = disk_free_gb('D:\\')
        if free < DISK_FLOOR_GB:
            msg = f'ổ D còn {int(free)} GB, dưới {DISK_FLOOR_GB} GB — dừng'
            log.line(msg)
            summary['errors'].append({'stage': 'disk', 'message': msg})
            return finish(EXIT_DISK)
        log.line(f'bắt đầu{" (chạy thử)" if args.dry_run else ""} · ổ D còn {int(free)} GB')
        try:
            code = run_stages(cfg, log, summary, args)
        except Exception as e:
            log.line('lỗi không lường trước:\n' + traceback.format_exc())
            summary['errors'].append({'stage': 'crash', 'message': f'{type(e).__name__}: {e}'})
            code = EXIT_STAGE
        if summary['errors'] and code == EXIT_OK:
            code = EXIT_STAGE
        log.line(f'xong, mã thoát {code}')
        return finish(code)
    finally:
        release_mutex(handle)


if __name__ == '__main__':
    sys.exit(main())
