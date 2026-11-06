"""Clone queue runner: holds one claim open to Ecom Manager, checks each clone job, finds the personaliser the source
page uses, hands the job to a headless session and reports the outcome.

    set ECOM_URL=https://...
    set CLONE_WORKER_TOKEN=cqw_...
    python runner.py                 # claim loop
    python runner.py --once          # one claim (and its job, if any), then exit
    python runner.py --job-root D:\\other\\folder
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import detect
from api import FAIL_KINDS, TIMEOUT_S, ApiError, AuthError, Client

KNOWN_STORES = {'LIT': 'litzzy', 'REMI': 'reminiso'}
SOURCE_URL_RE = re.compile(r"^https://[a-z0-9.-]+(/[A-Za-z0-9._-]*)*(\?view=[A-Za-z0-9_-]+)?$")
SKU_CODE_RE = re.compile(r'^[A-Z]{2}\d{10}$', re.ASCII)
JOB_ID_RE = re.compile(r'^[a-z0-9]{10,40}$')

DEFAULT_JOB_ROOT = r'D:\Ecom manager\clone-queue'
LOCK_NAME = 'runner.lock'
CLAIM_WAIT_S = 25
MAX_BACKOFF_S = 60
HEARTBEAT_S = 60
SESSION_TIMEOUT_S = 7200
RESULT_RETRIES = 5
RESULT_RETRY_S = 30
FAIL_RETRIES = 3
FAIL_RETRY_S = 10
DETECT_STAGE = 'nhận diện'
SESSION_STAGES = ('clone', 'qa', 'public')
REUSED_NOTE = 'Đã có sẵn trong sổ đăng ký'
SETUP_ERROR = 'Runner không chuẩn bị được job.'
AUTH_MESSAGE = 'Máy chủ từ chối token (401). Kiểm lại CLONE_WORKER_TOKEN rồi chạy lại runner.'
# The byte locked sits past the pid text so other programs can still read the pid while the runner holds the lock.
LOCK_OFFSET = 1 << 20


def log(msg: str) -> None:
    line = f'[{time.strftime("%m/%d/%Y %H:%M:%S")}] {msg}'
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode('ascii', 'backslashreplace').decode('ascii'), flush=True)


@dataclass
class Deps:
    client: Any
    fetch_html: Callable[[str], str | None]
    find_existing: Callable[[dict], dict | None]
    run_session: Callable[..., dict]
    job_root: str
    clock: Any = time


def default_deps(client: Client, job_root: str) -> Deps:
    import registers
    import session
    return Deps(client=client, fetch_html=detect.fetch_html, find_existing=registers.find_existing,
                run_session=session.run_session, job_root=job_root, clock=time)


def validate_job(job: dict) -> str | None:
    if not isinstance(job, dict):
        return 'Job không đúng dạng.'
    url = job.get('sourceUrl')
    if not isinstance(url, str) or not SOURCE_URL_RE.fullmatch(url):
        return 'Link nguồn không hợp lệ.'
    sku = job.get('skuCode')
    if not isinstance(sku, str) or not SKU_CODE_RE.fullmatch(sku):
        return 'Mã SKU không hợp lệ.'
    store = job.get('store')
    prefix = store.get('orderPrefix') if isinstance(store, dict) else None
    if not isinstance(prefix, str) or prefix not in KNOWN_STORES:
        return 'Store không thuộc danh sách runner biết.'
    job_id = job.get('id')
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        return 'Mã job không hợp lệ.'
    return None


def read_stage(job_dir: str) -> str:
    try:
        with open(os.path.join(job_dir, 'stage.txt'), encoding='utf-8', errors='replace') as fh:
            first = fh.readline(64).strip()
    except OSError:
        return 'clone'
    return first if first in SESSION_STAGES else 'clone'


def beat(client, job: dict, stage: str, platform: str | None = None) -> bool:
    """False when the server says the job is no longer ours (lease lost) or was cancelled."""
    try:
        r = client.heartbeat(job['id'], job.get('attempts'), stage=stage, platform=platform)
    except AuthError:
        raise
    except ApiError as e:
        log(f'Job {job["id"]}: heartbeat lỗi ({e}).')
        return True
    return bool(r.get('ok')) and not r.get('cancelled')


class Heartbeat:
    def __init__(self, client, job: dict, job_dir: str):
        self._client, self._job, self._job_dir = client, job, job_dir
        self._done = threading.Event()
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f'heartbeat-{job["id"]}', daemon=True)

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._done.set()
        self._thread.join(timeout=TIMEOUT_S + 10)

    def should_stop(self) -> bool:
        return self._stopped.is_set()

    def _run(self) -> None:
        while not self._done.is_set():
            try:
                alive = beat(self._client, self._job, read_stage(self._job_dir))
            except AuthError:
                log(AUTH_MESSAGE)
                alive = False
            except Exception as e:
                log(f'Job {self._job["id"]}: heartbeat lỗi ({type(e).__name__}: {e}).')
                alive = True
            if not alive:
                self._stopped.set()
                return
            if self._done.wait(HEARTBEAT_S):
                return


def _fail(job: dict, deps, kind: str, error, retryable: bool = False, product_gid=None) -> None:
    error = str(error)
    log(f'Job {job.get("id")}: {kind} {error}')
    gid = product_gid if isinstance(product_gid, str) and product_gid else None
    for n in range(FAIL_RETRIES + 1):
        if n:
            deps.clock.sleep(FAIL_RETRY_S)
        try:
            deps.client.fail(job.get('id'), job.get('attempts'), kind, error, retryable=retryable, product_gid=gid)
            return
        except AuthError:
            raise
        except ApiError as e:
            log(f'Job {job.get("id")}: gửi báo lỗi không được ({e}).')
    log(f'Job {job.get("id")}: bỏ cuộc sau {FAIL_RETRIES + 1} lần gửi báo lỗi; job nằm chờ tới khi hết lease.')


def _report_pass(job: dict, deps, payload: dict) -> None:
    payload = {k: v for k, v in payload.items() if v is not None}
    gid = payload.get('productGid')
    if not isinstance(gid, str):
        _fail(job, deps, 'TOOL', 'Phiên báo PASS nhưng thiếu productGid.')
        return
    status, body = 0, {}
    for n in range(RESULT_RETRIES + 1):
        if n:
            deps.clock.sleep(RESULT_RETRY_S)
        try:
            status, body = deps.client.result(job['id'], job.get('attempts'), payload)
        except AuthError:
            raise
        except ApiError as e:
            log(f'Job {job["id"]}: gửi kết quả lỗi ({e}).')
            continue
        if status < 500:
            break
        log(f'Job {job["id"]}: máy chủ trả HTTP {status} khi nhận kết quả.')
    else:
        _fail(job, deps, 'TOOL', f'Không gửi được kết quả sau {RESULT_RETRIES + 1} lần thử.', retryable=True,
              product_gid=gid)
        return
    if status == 200:
        log(f'Job {job["id"]}: {body.get("status")} {body.get("error") or ""}'.rstrip())
    elif status == 404:
        log(f'Job {job["id"]}: máy chủ không còn job này (404).')
    else:
        _fail(job, deps, 'TOOL', f'Máy chủ trả HTTP {status} khi nhận kết quả.', product_gid=gid)


def _report(job: dict, deps, outcome) -> None:
    outcome = outcome if isinstance(outcome, dict) else {}
    verdict = outcome.get('verdict')
    if verdict == 'PASS':
        _report_pass(job, deps, {
            'productGid': outcome.get('productGid'), 'handle': outcome.get('handle'), 'qaVerdict': 'PASS',
            'qaNote': outcome.get('note'), 'reused': outcome.get('reused'), 'costUsd': outcome.get('costUsd'),
            'durationMs': outcome.get('durationMs'),
        })
    elif verdict == 'UNSUPPORTED':
        _fail(job, deps, 'UNSUPPORTED', outcome.get('error') or outcome.get('note') or 'Nền tảng này chưa hỗ trợ.')
    elif verdict == 'FAIL':
        kind = outcome.get('failKind') if outcome.get('failKind') in FAIL_KINDS else 'TOOL'
        _fail(job, deps, kind, outcome.get('error') or outcome.get('note') or 'Phiên clone báo lỗi.',
              product_gid=outcome.get('productGid'))
    else:
        _fail(job, deps, 'TOOL', f'Phiên clone trả kết quả lạ: {verdict!r}.')


def run_job(job: dict, deps) -> None:
    reason = validate_job(job)
    if reason:
        job = job if isinstance(job, dict) else {}
        _fail(job, deps, 'TOOL', reason)
        return
    job_id = job['id']
    prefix = job['store']['orderPrefix']
    log(f'Job {job_id}: {job["skuCode"]} {job["sourceUrl"]} -> {prefix}')

    try:
        existing = deps.find_existing(job)
    except Exception as e:
        log(f'Job {job_id}: đọc sổ đăng ký lỗi ({type(e).__name__}: {e}).')
        _fail(job, deps, 'TOOL', SETUP_ERROR)
        return
    if existing is not None:
        gid = existing.get('productGid') if isinstance(existing, dict) else None
        handle = existing.get('handle') if isinstance(existing, dict) else None
        if not isinstance(gid, str) or not gid or not isinstance(handle, (str, type(None))):
            log(f'Job {job_id}: sổ đăng ký trả giá trị lạ ({type(existing).__name__}).')
            _fail(job, deps, 'TOOL', SETUP_ERROR)
            return
        _report_pass(job, deps, {'productGid': gid, 'handle': handle, 'qaVerdict': 'PASS', 'qaNote': REUSED_NOTE,
                                 'reused': True})
        return

    if not beat(deps.client, job, DETECT_STAGE):
        log(f'Job {job_id}: đã huỷ hoặc không còn thuộc máy này.')
        return
    html = deps.fetch_html(job['sourceUrl'])
    platform = detect.detect_platform(html) if html else 'unknown'
    log(f'Job {job_id}: nền tảng {platform}{"" if html else " (không tải được trang)"}.')
    if not beat(deps.client, job, DETECT_STAGE, platform):
        log(f'Job {job_id}: đã huỷ hoặc không còn thuộc máy này.')
        return
    if platform.startswith('unsupported:'):
        _fail(job, deps, 'UNSUPPORTED', f'Nền tảng này chưa hỗ trợ ({platform.split(":", 1)[1]}).')
        return
    targets = job.get('targets') if isinstance(job.get('targets'), list) else []
    if platform in detect.PLATFORMS and f'{platform}:{prefix}' not in targets:
        _fail(job, deps, 'NOT_ENABLED', f'Chưa bật clone {platform} cho store {prefix}.')
        return

    job_dir = os.path.join(deps.job_root, job_id)
    try:
        os.makedirs(job_dir, exist_ok=True)
        try:
            os.remove(os.path.join(job_dir, 'stage.txt'))
        except FileNotFoundError:
            pass
    except OSError as e:
        log(f'Job {job_id}: không dựng được thư mục job ({type(e).__name__}: {e}).')
        _fail(job, deps, 'TOOL', SETUP_ERROR)
        return
    hb = Heartbeat(deps.client, job, job_dir)
    hb.start()
    try:
        outcome = deps.run_session(job, platform, job_dir, hb.should_stop, timeout_s=SESSION_TIMEOUT_S)
    except Exception as e:
        outcome = {'verdict': 'FAIL', 'failKind': 'TOOL', 'error': f'Phiên clone lỗi: {type(e).__name__}: {e}'}
    finally:
        hb.close()
    if hb.should_stop():
        log(f'Job {job_id}: đã dừng phiên vì job bị huỷ hoặc không còn thuộc máy này; không báo kết quả.')
        return
    log(f'Job {job_id}: phiên trả {outcome.get("verdict") if isinstance(outcome, dict) else outcome!r}.')
    _report(job, deps, outcome)


def serve(deps, once: bool = False) -> int:
    delay = 0
    while True:
        try:
            got = deps.client.claim(wait_seconds=CLAIM_WAIT_S)
        except AuthError:
            log(AUTH_MESSAGE)
            return 3
        except ApiError as e:
            delay = min(delay * 2 or 2, MAX_BACKOFF_S)
            log(f'Không gọi được máy chủ ({e}); thử lại sau {delay} giây.')
            if once:
                return 1
            deps.clock.sleep(delay)
            continue
        delay = 0
        job = got.get('job')
        if job:
            try:
                run_job(job, deps)
            except AuthError:
                log(AUTH_MESSAGE)
                return 3
            except Exception as e:
                log(f'Lỗi khi xử lý job: {type(e).__name__}: {e}')
        if once:
            return 0


def acquire_lock(path: str) -> int | None:
    """An OS lock held on the open file for the runner's lifetime; the OS drops it when the process dies.

    Returns the file descriptor to keep, or None when another runner holds the lock. The pid written into the file
    is information only."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, LOCK_OFFSET, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, str(os.getpid()).encode('ascii'))
    return fd


def release_lock(fd: int) -> None:
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, LOCK_OFFSET, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    os.close(fd)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='Clone queue runner')
    ap.add_argument('--once', action='store_true', help='one claim (and its job, if any), then exit')
    ap.add_argument('--job-root', default=DEFAULT_JOB_ROOT, help='folder holding one sub-folder per job')
    args = ap.parse_args(argv)
    base = os.environ.get('ECOM_URL', '').strip()
    token = os.environ.get('CLONE_WORKER_TOKEN', '').strip()
    if not base or not token:
        log('Thiếu ECOM_URL hoặc CLONE_WORKER_TOKEN trong biến môi trường.')
        return 2
    try:
        client = Client(base, token)
    except ValueError as e:
        log(str(e))
        return 2
    os.makedirs(args.job_root, exist_ok=True)
    lock = os.path.join(args.job_root, LOCK_NAME)
    lock_fd = acquire_lock(lock)
    if lock_fd is None:
        log(f'Một runner khác đang chạy (khoá {lock}).')
        return 1
    try:
        deps = default_deps(client, args.job_root)
        log(f'Runner đang chạy, thư mục job {args.job_root}.')
        return serve(deps, once=args.once)
    finally:
        release_lock(lock_fd)


if __name__ == '__main__':
    sys.exit(main())
