"""Design Agent runner: claims jobs from Ecom Manager and runs each in a headless Claude Code session on this PC.

One process, one claim loop, one thread per running job. See README.md and the spec
docs/superpowers/specs/2026-11-12-designer-agent-design.md ("Runner on the PC", "Interface contract").
"""
from __future__ import annotations

import argparse
import dataclasses
import importlib.util
import json
import os
import re
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import agent_api
from agent_api import AgentApi, ApiError, AuthError, read_env

HERE = Path(__file__).resolve().parent

EXIT_OK, EXIT_CONFIG, EXIT_AUTH, EXIT_CLI = 0, 2, 3, 4
KINDS = {'FIX': 'fix.md', 'MAKE': 'make.md', 'MOCKUP': 'mockup.md', 'LIBRARY_APPLY': 'library-apply.md'}
KEY_RE = r'^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'
ID_RE = r'^[A-Za-z0-9_-]{1,64}$'
DEFAULT_ARTWORK_BUILDER = r'D:\Ecom manager\artwork-builder'
DEFAULT_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,Skill'
STALE_NAMES = ('result.json', 'stage.txt', 'session.log', 'api-calls.jsonl', 'ps-lock.held')


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    ecom_url: str
    token: str
    max_concurrent: int
    claude_bin: str
    project_dir: Path
    artwork_builder: Path
    codex_bin: str
    allowed_tools: tuple
    permission_mode: str
    model: str
    job_timeout_s: float
    bash_timeout_ms: int


def _number(values: dict, key: str, default, cast, path: Path):
    raw = values.get(key, '').strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError:
        raise ConfigError(f'{key} phải là số (đang là "{raw}") trong {path}') from None


def load_config(path: Path) -> Config:
    path = Path(path)
    if not path.is_file():
        raise ConfigError(f'không thấy file cấu hình {path}')
    values = read_env(path)

    def need(key: str) -> str:
        value = values.get(key, '').strip()
        if not value:
            raise ConfigError(f'thiếu {key} trong {path}')
        return value

    ecom_url, token, project = need('ECOM_URL'), need('DESIGN_AGENT_TOKEN'), need('PROJECT_DIR')
    try:
        agent_api.check_base_url(ecom_url)
    except ValueError as exc:
        raise ConfigError(f'ECOM_URL không hợp lệ trong {path}: {exc}') from None
    project_dir = Path(project)
    if not (project_dir / 'CLAUDE.md').is_file():
        raise ConfigError(f'PROJECT_DIR không phải thư mục dự án (không có CLAUDE.md): {project_dir} (file {path})')
    builder = Path(values.get('ARTWORK_BUILDER', '').strip() or DEFAULT_ARTWORK_BUILDER)
    if not builder.is_dir():
        raise ConfigError(f'ARTWORK_BUILDER không phải thư mục: {builder} (file {path})')
    claude_bin = values.get('CLAUDE_BIN', '').strip() or 'claude'
    if claude_bin.lower().endswith(('.cmd', '.bat')):
        raise ConfigError(f'CLAUDE_BIN không được là .cmd / .bat: {claude_bin} (file {path}); dùng claude.exe')
    tools = tuple(t for t in re.split(r'[,\s]+', values.get('CLAUDE_ALLOWED_TOOLS', '').strip() or DEFAULT_TOOLS) if t)
    max_concurrent = max(1, min(10, _number(values, 'MAX_CONCURRENT', 5, int, path)))
    minutes = _number(values, 'JOB_TIMEOUT_MINUTES', 90, float, path)
    return Config(
        ecom_url=ecom_url, token=token, max_concurrent=max_concurrent, claude_bin=claude_bin,
        project_dir=project_dir, artwork_builder=builder, codex_bin=values.get('CODEX_BIN', '').strip(),
        allowed_tools=tools, permission_mode=values.get('CLAUDE_PERMISSION_MODE', '').strip() or 'dontAsk',
        model=values.get('CLAUDE_MODEL', '').strip(), job_timeout_s=minutes * 60,
        bash_timeout_ms=_number(values, 'BASH_TIMEOUT_MS', 3600000, int, path))


def resolve_codex(configured: str, local_appdata: str | None = None) -> str:
    if configured:
        if not Path(configured).is_file():
            raise ConfigError(f'CODEX_BIN không phải file: {configured}')
        return configured
    base = Path(local_appdata or os.environ.get('LOCALAPPDATA', '')) / 'OpenAI' / 'Codex' / 'bin'
    found = [p for p in base.glob('*/codex.exe') if p.is_file()]
    if not found:
        raise ConfigError(f'không thấy codex.exe trong {base}')
    return str(max(found, key=lambda p: p.stat().st_mtime))


class Log:
    def __init__(self, home: Path, secrets: list[str]):
        self.dir = Path(home) / 'logs'
        self.secrets = sorted((s for s in secrets if s), key=len, reverse=True)
        self.lock = threading.Lock()

    def line(self, text: str) -> None:
        for secret in self.secrets:
            text = text.replace(secret, '***')
        now = datetime.now()
        entry = f'[{now:%Y-%m-%d %H:%M:%S}] {text}'
        with self.lock:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                with open(self.dir / f'runner-{now:%Y-%m-%d}.log', 'a', encoding='utf-8') as fh:
                    fh.write(entry + '\n')
            except OSError:
                pass
            try:
                print(entry, flush=True)
            except (UnicodeError, OSError):
                pass


def prune_logs(home: Path, days: int = 30) -> int:
    removed = 0
    cutoff = time.time() - days * 86400
    for path in (Path(home) / 'logs').glob('runner-*.log'):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            pass
    return removed


def validate_job(job: dict) -> str | None:
    if not isinstance(job, dict) or not re.match(ID_RE, str(job.get('id') or '')):
        return 'job thiếu id hợp lệ'
    if job.get('kind') not in KINDS:
        return f'loại job không hỗ trợ: {job.get("kind")}'
    task = job.get('task')
    if not isinstance(task, dict) or not re.match(KEY_RE, str(task.get('key') or '')):
        return 'mã task không hợp lệ'
    return None


def job_dir_for(cfg: Config, job: dict) -> Path:
    return cfg.artwork_builder / f'{job["task"]["key"]}-agent-{job["id"]}'


def prepare_job_dir(cfg: Config, job: dict, codex_bin: str, now: datetime) -> Path:
    d = job_dir_for(cfg, job)
    d.mkdir(parents=True, exist_ok=True)
    stamp = now.strftime('%Y%m%d-%H%M%S')
    for name in STALE_NAMES:
        old = d / name
        if old.exists():
            os.replace(old, d / f'prev-{stamp}-{name}')
    saved = dict(job)
    saved['runner'] = {'jobDir': str(d), 'attempt': job.get('attempts'), 'codexBin': codex_bin,
                       'artworkBuilder': str(cfg.artwork_builder), 'projectDir': str(cfg.project_dir),
                       'claimedAt': now.isoformat(timespec='seconds')}
    (d / 'job.json').write_text(json.dumps(saved, ensure_ascii=False, indent=1), encoding='utf-8')
    (d / 'runner-state.json').write_text(json.dumps(
        {'jobId': job['id'], 'attempt': job.get('attempts'), 'startedAt': now.isoformat(timespec='seconds'),
         'finished': False, 'outcome': None}, ensure_ascii=False), encoding='utf-8')
    return d


def _safe(text: str) -> str:
    return re.sub(r'[^A-Za-z0-9 ._-]', '_', text)


def fetch_current_files(api: AgentApi, job: dict, job_dir: Path) -> list[dict]:
    cur = Path(job_dir) / 'current'
    cur.mkdir(parents=True, exist_ok=True)
    index: list[dict] = []
    for item in job.get('files') or []:
        art_id = item.get('id') or str(item.get('url', '')).rstrip('/').rsplit('/', 1)[-1]
        ext = _safe(Path(str(item.get('fileName') or '')).suffix)
        name = _safe(f'{item.get("kind")}-{item.get("printArea")}-v{item.get("version")}') + ext
        dest = cur / name
        api.download(art_id, dest)
        index.append({'id': art_id, 'kind': item.get('kind'), 'printArea': item.get('printArea'),
                      'version': item.get('version'), 'fileName': item.get('fileName'), 'path': str(dest)})
    (cur / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')
    return index


def _posix(p) -> str:
    return Path(p).as_posix()


def render_prompt(cfg: Config, job: dict, job_dir: Path, codex_bin: str) -> str:
    text = (HERE / 'prompts' / KINDS[job['kind']]).read_text(encoding='utf-8')
    py = _posix(sys.executable)
    values = {'JOB_DIR': _posix(job_dir), 'ARTWORK_BUILDER': _posix(cfg.artwork_builder),
              'PROJECT_DIR': _posix(cfg.project_dir), 'CODEX_BIN': _posix(codex_bin), 'PYTHON': py,
              'AGENT': f'"{py}" "{_posix(HERE / "agent_api.py")}"'}
    for key, value in values.items():
        text = text.replace('{{' + key + '}}', value)
    (Path(job_dir) / 'prompt.md').write_text(text, encoding='utf-8')
    return text


def build_argv(cfg: Config, prompt: str, job_dir: Path, claude_cmd: list[str] | None = None) -> list[str]:
    argv = [*(claude_cmd or [cfg.claude_bin]), '-p', prompt, '--output-format', 'json',
            '--permission-mode', cfg.permission_mode, '--allowedTools', *cfg.allowed_tools,
            '--add-dir', str(job_dir), str(cfg.artwork_builder)]
    if cfg.model:
        argv += ['--model', cfg.model]
    return argv


def child_env(cfg: Config, job_dir: Path, base=None) -> dict:
    env = dict(os.environ if base is None else base)
    env.pop('DESIGN_AGENT_TOKEN', None)
    env.update({'DESIGN_AGENT_JOB_DIR': str(job_dir), 'BASH_DEFAULT_TIMEOUT_MS': str(cfg.bash_timeout_ms),
                'BASH_MAX_TIMEOUT_MS': str(cfg.bash_timeout_ms), 'DISABLE_AUTOUPDATER': '1',
                'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    return env


def read_stage(job_dir: Path) -> str:
    try:
        lines = (Path(job_dir) / 'stage.txt').read_text(encoding='utf-8-sig', errors='replace').splitlines()
    except OSError:
        return 'khởi động'
    first = lines[0].strip()[:200] if lines else ''
    return first or 'khởi động'


def read_rounds(job_dir: Path) -> int:
    best = 0
    try:
        for p in Path(job_dir).iterdir():
            m = re.fullmatch(r'round-(\d+)', p.name)
            if m and p.is_dir():
                best = max(best, int(m.group(1)))
    except OSError:
        pass
    return best


def read_result(job_dir: Path) -> tuple[dict | None, str | None]:
    path = Path(job_dir) / 'result.json'
    if not path.exists():
        return None, None
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as exc:
        return None, f'không đọc được JSON ({type(exc).__name__})'
    if not isinstance(data, dict):
        return None, 'không phải một object JSON'
    if data.get('outcome') not in ('DONE', 'NEEDS_OWNER'):
        return None, 'outcome phải là DONE hoặc NEEDS_OWNER'
    summary = data.get('summary')
    if not isinstance(summary, str) or not summary.strip():
        return None, 'thiếu summary'
    rounds = data.get('rounds')
    rounds = rounds if isinstance(rounds, int) and not isinstance(rounds, bool) and rounds >= 0 else read_rounds(job_dir)
    rest = {k: v for k, v in data.items() if k not in ('outcome', 'summary', 'rounds')}
    return {'outcome': data['outcome'], 'summary': summary[:4000], 'rounds': rounds, 'result': rest}, None


_PROC = None


def load_proc():
    global _PROC
    if _PROC is not None:
        return _PROC
    path = HERE.parent / 'clone-runner' / 'proc.py'
    if not path.is_file():
        raise ConfigError('không thấy tools/clone-runner/proc.py')
    spec = importlib.util.spec_from_file_location('clone_runner_proc', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['clone_runner_proc'] = module
    spec.loader.exec_module(module)
    _PROC = module
    return module


@dataclass
class Deps:
    cfg: Config
    api: AgentApi
    log: Log
    claude_cmd: list | None = None
    heartbeat_s: float = 60
    timeout_s: float | None = None
    cli_down_window_s: float = 90
    cli_backoff_s: float = 1800
    report_retries: int = 3
    report_retry_s: float = 10
    clock: object = time


def release_ps_lock(cfg: Config, job_dir: Path, log: Log) -> bool:
    marker = Path(job_dir) / 'ps-lock.held'
    if not marker.exists():
        return False
    try:
        marker.unlink()
    except OSError:
        pass
    lock = cfg.artwork_builder / '.ps-lock'
    if not lock.exists():
        return False
    try:
        lock.rmdir()
    except OSError:
        log.line(f'không gỡ được .ps-lock của phiên {Path(job_dir).name}')
        return False
    log.line(f'gỡ .ps-lock do phiên {Path(job_dir).name} bỏ lại')
    return True


def _set_state(job_dir: Path, **changes) -> None:
    path = Path(job_dir) / 'runner-state.json'
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        state = {}
    state.update(changes)
    try:
        path.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass


def _send(deps: Deps, jid: str, label: str, call):
    """(reply, state) with state one of ok / auth / conflict / refused / net; a network error is retried."""
    for attempt in range(max(1, deps.report_retries)):
        try:
            return call(), 'ok'
        except AuthError:
            return None, 'auth'
        except ApiError as exc:
            if exc.status == 409:
                deps.log.line(f'server không còn giữ job {jid} (409)')
                return None, 'conflict'
            if exc.status is None:
                deps.log.line(f'lỗi mạng khi gửi {label} job {jid} (lần {attempt + 1})')
                if attempt + 1 < deps.report_retries:
                    deps.clock.sleep(deps.report_retry_s)
                continue
            deps.log.line(f'server từ chối {label} job {jid} (HTTP {exc.status})')
            return None, 'refused'
    deps.log.line(f'không gửi được kết quả job {jid}; để server thu hồi theo lease')
    return None, 'net'


def _fail(deps: Deps, jid: str, error: str, permanent: bool, ret: str, job_dir: Path | None = None) -> str:
    deps.log.line(f'job {jid} lỗi: {error}')
    _, state = _send(deps, jid, 'fail', lambda: deps.api.fail(jid, error, permanent))
    out = {'auth': 'AUTH', 'net': 'LOST'}.get(state, ret)
    if job_dir:
        _set_state(job_dir, finished=True, outcome=out)
    return out


CLI_DOWN_TEXT = 'Claude CLI không chạy được (chưa đăng nhập, hết hạn mức hoặc lỗi khởi động)'


def run_job(job: dict, deps: Deps, stop: threading.Event) -> str:
    cfg, api, log = deps.cfg, deps.api, deps.log
    reason = validate_job(job)
    jid = str((job or {}).get('id') or '')
    if reason:
        if not re.match(ID_RE, jid):
            log.line(f'bỏ qua job không hợp lệ: {reason}')
            return 'FAILED'
        return _fail(deps, jid, reason, True, 'FAILED')
    key = job['task']['key']
    try:
        codex = resolve_codex(cfg.codex_bin)
    except ConfigError as exc:
        return _fail(deps, jid, str(exc), False, 'FAILED')
    job_dir = prepare_job_dir(cfg, job, codex, datetime.now())
    log.line(f'job {jid} ({job["kind"]} {key}) lần {job.get("attempts")}: {job_dir}')
    try:
        fetch_current_files(api, job, job_dir)
    except AuthError:
        _set_state(job_dir, finished=True, outcome='AUTH')
        return 'AUTH'
    except ApiError as exc:
        return _fail(deps, jid, f'không tải được file hiện tại của task (HTTP {exc.status or "mạng"})', False,
                     'FAILED', job_dir)
    prompt = render_prompt(cfg, job, job_dir, codex)
    try:
        if not api.heartbeat(jid, read_stage(job_dir), read_rounds(job_dir)):
            log.line(f'job {jid}: server không còn giữ job (409), không mở phiên')
            _set_state(job_dir, finished=True, outcome='LOST')
            return 'LOST'
    except AuthError:
        _set_state(job_dir, finished=True, outcome='AUTH')
        return 'AUTH'
    except ApiError:
        log.line(f'job {jid}: chưa gửi được nhịp đầu')
    proc = load_proc()
    argv = build_argv(cfg, prompt, job_dir, deps.claude_cmd)
    out = open(job_dir / 'session.log', 'wb')
    try:
        child = proc.spawn(argv, cwd=str(cfg.project_dir), env=child_env(cfg, job_dir), out=out, secrets=[cfg.token])
    except OSError:
        out.close()
        return _fail(deps, jid, CLI_DOWN_TEXT, False, 'CLI_DOWN', job_dir)
    if os.name == 'nt' and not child.contained:
        log.line(f'job {jid}: {proc.CONTAIN_FAILED} (pid {child.pid})')
    started = deps.clock.monotonic()
    flags = {'lost': False, 'auth': False}
    done = threading.Event()

    def beat():
        while not done.wait(deps.heartbeat_s):
            try:
                if not api.heartbeat(jid, read_stage(job_dir), read_rounds(job_dir)):
                    flags['lost'] = True
            except AuthError:
                flags['auth'] = True
            except ApiError:
                log.line(f'job {jid}: không gửi được nhịp tim')

    beater = threading.Thread(target=beat, name=f'beat-{jid}', daemon=True)
    beater.start()
    timeout = deps.timeout_s if deps.timeout_s is not None else cfg.job_timeout_s
    status = proc.wait(child, timeout, lambda: stop.is_set() or flags['lost'] or flags['auth'])
    elapsed = deps.clock.monotonic() - started
    done.set()
    beater.join(5)
    proc.close(child)
    out.close()
    release_ps_lock(cfg, job_dir, log)

    if status == 'stopped':
        outcome = 'AUTH' if flags['auth'] else 'LOST'
        log.line(f'job {jid}: đã dừng phiên ({outcome})')
        _set_state(job_dir, finished=True, outcome=outcome)
        return outcome
    if status == 'timeout':
        return _fail(deps, jid, f'quá {cfg.job_timeout_s / 60:g} phút chưa xong — đã dừng phiên', True, 'FAILED', job_dir)
    res, why = read_result(job_dir)
    if why:
        return _fail(deps, jid, f'result.json không hợp lệ: {why}', True, 'FAILED', job_dir)
    if res is None:
        if elapsed < deps.cli_down_window_s:
            return _fail(deps, jid, CLI_DOWN_TEXT, False, 'CLI_DOWN', job_dir)
        return _fail(deps, jid, 'phiên kết thúc mà không có result.json', False, 'FAILED', job_dir)
    reply, state = _send(deps, jid, 'result',
                         lambda: api.result(jid, res['outcome'], res['summary'], res['rounds'], res['result']))
    if state == 'ok':
        got = reply.get('status') or res['outcome']
        if got != res['outcome']:
            log.line(f'server ghi nhận job {jid} là {got}')
        outcome = got if got in ('DONE', 'NEEDS_OWNER') else 'FAILED'
    else:
        outcome = {'auth': 'AUTH', 'refused': 'FAILED'}.get(state, 'LOST')
    log.line(f'job {jid}: {outcome}')
    _set_state(job_dir, finished=True, outcome=outcome)
    return outcome


CLAIM_WAIT_S = 25
DISK_FLOOR_GB = 30
LOW_DISK_WAIT_S = 300
MAX_BACKOFF_S = 60


def acquire_lock(path: Path) -> int | None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def release_lock(fd: int) -> None:
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def recover_after_restart(cfg: Config, log: Log) -> int:
    abandoned = 0
    for d in sorted(cfg.artwork_builder.glob('*-agent-*')):
        if not d.is_dir():
            continue
        release_ps_lock(cfg, d, log)
        path = d / 'runner-state.json'
        try:
            state = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(state, dict) and state.get('finished') is False and not state.get('abandoned'):
            log.line(f'job {state.get("jobId")} của lần chạy trước: để server thu hồi theo lease')
            state['abandoned'] = True
            try:
                path.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
            except OSError:
                pass
            abandoned += 1
    return abandoned


def _disk_free_gb(path) -> float:
    return shutil.disk_usage(path).free / 2 ** 30


def _pause(deps: Deps, stop: threading.Event, seconds: float) -> None:
    if deps.clock is time:
        stop.wait(seconds)
    else:
        deps.clock.sleep(seconds)


def serve(deps: Deps, once: bool = False, stop: threading.Event | None = None, disk_free_gb=_disk_free_gb) -> int:
    cfg, log = deps.cfg, deps.log
    stop = stop if stop is not None else threading.Event()
    wake = threading.Event()
    running: list = []
    outcomes: list[str] = []
    paused_until = 0.0
    backoff = 0
    claimed = False
    exit_code = EXIT_OK

    def start(job: dict) -> None:
        holder: list = []

        def target():
            try:
                holder.append(run_job(job, deps, stop))
            except Exception as exc:
                holder.append('FAILED')
                log.line(f'job {job.get("id")}: lỗi nội bộ của runner ({type(exc).__name__}: {exc})')
                try:
                    deps.api.fail(str(job.get('id')), 'lỗi nội bộ của runner', False)
                except Exception:
                    pass
            finally:
                wake.set()

        thread = threading.Thread(target=target, name=f'job-{job.get("id")}', daemon=True)
        running.append((thread, holder))
        thread.start()

    def collect() -> None:
        nonlocal paused_until
        for entry in list(running):
            thread, holder = entry
            if thread.is_alive():
                continue
            running.remove(entry)
            outcome = holder[0] if holder else 'FAILED'
            outcomes.append(outcome)
            if outcome == 'CLI_DOWN':
                paused_until = deps.clock.monotonic() + deps.cli_backoff_s
                log.line(f'Claude CLI không chạy được: tạm ngừng nhận job {deps.cli_backoff_s / 60:g} phút')

    try:
        while not stop.is_set():
            collect()
            if 'AUTH' in outcomes:
                break
            if once and claimed:
                if not running:
                    break
                wake.wait(1.0)
                wake.clear()
                continue
            free = cfg.max_concurrent - len(running)
            if free <= 0 or deps.clock.monotonic() < paused_until:
                wake.wait(1.0)
                wake.clear()
                continue
            if disk_free_gb(cfg.artwork_builder) < DISK_FLOOR_GB:
                log.line('ổ đĩa còn dưới 30 GB: chưa nhận job, 5 phút nữa kiểm lại')
                if once:
                    break
                _pause(deps, stop, LOW_DISK_WAIT_S)
                continue
            try:
                jobs = deps.api.claim(free, CLAIM_WAIT_S)
            except AuthError:
                log.line('máy chủ từ chối token (401): dừng runner')
                outcomes.append('AUTH')
                break
            except ApiError as exc:
                backoff = min(MAX_BACKOFF_S, backoff * 2 if backoff else 2)
                log.line(f'không gọi được máy chủ ({exc.status or "mạng"}); thử lại sau {backoff} giây')
                if once:
                    break
                _pause(deps, stop, backoff)
                continue
            backoff = 0
            claimed = True
            for job in jobs:
                start(job)
    except KeyboardInterrupt:
        stop.set()
    finally:
        if 'AUTH' in outcomes or stop.is_set():
            stop.set()
        for thread, _ in list(running):
            thread.join(120)
        collect()
    if 'AUTH' in outcomes:
        return EXIT_AUTH
    if once and 'CLI_DOWN' in outcomes:
        return EXIT_CLI
    return exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Design Agent runner')
    parser.add_argument('--once', action='store_true', help='nhận một lượt job, chạy xong rồi thoát')
    parser.add_argument('--config', help='đường dẫn runner.env')
    args = parser.parse_args(argv)
    home = agent_api.home()
    log = Log(home, [])
    path = Path(args.config) if args.config else agent_api.env_path()
    try:
        cfg = load_config(path)
        load_proc()
    except ConfigError as exc:
        log.line(f'cấu hình lỗi: {exc}')
        return EXIT_CONFIG
    log = Log(home, [cfg.token])
    fd = acquire_lock(home / 'runner.lock')
    if fd is None:
        log.line('một runner khác đang chạy')
        return EXIT_OK
    try:
        prune_logs(home)
        recover_after_restart(cfg, log)
        deps = Deps(cfg, AgentApi(cfg.ecom_url, cfg.token), log)
        log.line(f'runner bắt đầu: tối đa {cfg.max_concurrent} job cùng lúc, máy chủ {cfg.ecom_url}')
        code = serve(deps, once=args.once)
        log.line(f'runner dừng (mã {code})')
        return code
    finally:
        release_lock(fd)


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
