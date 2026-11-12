"""The Design Agent interface contract: a client class for the runner and a small CLI for the headless sessions.

Only this module speaks the contract (spec "Interface contract"). The token is never put in an exception, a repr, a
log line or the CLI's output.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests

BASE_PATH = '/api/design-agent/runner'
SHORT_TIMEOUT = (10, 60)
UPLOAD_TIMEOUT = (10, 1800)


def home() -> Path:
    custom = os.environ.get('DESIGN_AGENT_HOME')
    if custom:
        return Path(custom)
    base = os.environ.get('USERPROFILE') or str(Path.home())
    return Path(base) / '.design-agent'


def env_path() -> Path:
    custom = os.environ.get('DESIGN_AGENT_ENV')
    return Path(custom) if custom else home() / 'runner.env'


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in Path(path).read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key.strip()] = value
    return values


class ApiError(Exception):
    def __init__(self, status: int | None, body: dict | None = None, message: str = ''):
        self.status = status
        self.body = body or {}
        text = message or str(self.body.get('error') or '')
        super().__init__(f'HTTP {status}: {text}' if status else (text or 'lỗi mạng'))


class AuthError(ApiError):
    pass


def check_base_url(url: str) -> str:
    parts = urlsplit(url or '')
    if not (parts.scheme == 'https' or (parts.scheme == 'http' and parts.hostname in ('localhost', '127.0.0.1'))) \
            or not parts.hostname:
        raise ValueError('ECOM_URL phải là https://… (hoặc http://localhost…)')
    return url.rstrip('/')


def _seg(value: str) -> str:
    return quote(str(value), safe='')


class AgentApi:
    def __init__(self, base_url: str, token: str):
        self.base_url = check_base_url(base_url)
        self._token = token

    def __repr__(self) -> str:
        return f'AgentApi({self.base_url!r})'

    def _request(self, method: str, path: str, *, ok_statuses=(), timeout=SHORT_TIMEOUT, **kwargs):
        headers = {'Authorization': f'Bearer {self._token}', **kwargs.pop('headers', {})}
        try:
            resp = requests.request(method, self.base_url + BASE_PATH + path, headers=headers, timeout=timeout,
                                    allow_redirects=False, **kwargs)
        except requests.RequestException as exc:
            raise ApiError(None, {'error': f'không kết nối được máy chủ ({type(exc).__name__})'}) from None
        try:
            if 200 <= resp.status_code < 300 or resp.status_code in ok_statuses:
                return resp
            try:
                body = resp.json()
                if not isinstance(body, dict):
                    body = {'error': str(body)[:200]}
            except ValueError:
                body = {'error': (resp.text or '')[:200]}
            cls = AuthError if resp.status_code == 401 else ApiError
            raise cls(resp.status_code, body)
        except BaseException:
            resp.close()
            raise

    def _json(self, method: str, path: str, payload=None, **kwargs) -> dict:
        resp = self._request(method, path, json=payload if payload is not None else {}, **kwargs)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        resp.close()
        return data if isinstance(data, dict) else {}

    def claim(self, free: int, wait_seconds: int = 25) -> list[dict]:
        data = self._json('POST', '/claim', {'free': free, 'waitSeconds': wait_seconds},
                          timeout=(10, wait_seconds + 15))
        jobs = data.get('jobs')
        return jobs if isinstance(jobs, list) else []

    def heartbeat(self, job_id: str, stage: str, rounds: int) -> bool:
        resp = self._request('POST', f'/jobs/{_seg(job_id)}/heartbeat', ok_statuses=(409,),
                             json={'stage': stage, 'rounds': rounds})
        ok = resp.status_code != 409
        resp.close()
        return ok

    def result(self, job_id: str, outcome: str, summary: str, rounds: int, result: dict) -> dict:
        return self._json('POST', f'/jobs/{_seg(job_id)}/result',
                          {'outcome': outcome, 'summary': summary, 'rounds': rounds, 'result': result})

    def fail(self, job_id: str, error: str, permanent: bool) -> dict:
        return self._json('POST', f'/jobs/{_seg(job_id)}/fail', {'error': error, 'permanent': permanent})

    def note(self, task_key: str, message: str) -> dict:
        return self._json('POST', '/notes', {'taskKey': task_key, 'message': message})

    def upload(self, task_key: str, print_area: str, file_path: Path, mockup: bool = False) -> dict:
        file_path = Path(file_path)
        params = {'printArea': print_area, 'fileName': file_path.name, 'kind': 'MOCKUP' if mockup else 'PRINT'}
        with open(file_path, 'rb') as fh:
            resp = self._request('PUT', f'/tasks/{_seg(task_key)}/artwork', params=params, data=fh,
                                 headers={'Content-Type': 'application/octet-stream'}, timeout=UPLOAD_TIMEOUT)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        resp.close()
        return data if isinstance(data, dict) else {}

    def submit(self, task_key: str) -> dict:
        return self._json('POST', f'/tasks/{_seg(task_key)}/submit', {})

    def reopen(self, task_key: str, reason: str, note: str) -> dict:
        return self._json('POST', f'/tasks/{_seg(task_key)}/reopen', {'reason': reason, 'note': note})

    def download(self, artwork_id: str, dest: Path) -> int:
        dest = Path(dest)
        resp = self._request('GET', f'/files/{_seg(artwork_id)}', stream=True, timeout=(10, 300))
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + '.part')
        total = 0
        try:
            with open(part, 'wb') as fh:
                for chunk in resp.iter_content(65536):
                    fh.write(chunk)
                    total += len(chunk)
            os.replace(part, dest)
        except requests.RequestException:
            raise ApiError(None, {'error': 'mất kết nối khi tải file'}) from None
        finally:
            resp.close()
            if part.exists():
                try:
                    part.unlink()
                except OSError:
                    pass
        return total


USAGE = ('cách dùng: upload <taskKey> <vùng in> <file> [--mockup] | submit <taskKey> | '
         'reopen <taskKey> <lý do> <ghi chú> | note <taskKey> <nội dung> | download <artworkId> <file đích>')


REOPENED = ('DOING', 'REJECTED')
NOT_REOPENED = ('NEW', 'ASSIGNED', 'REVIEW', 'ASK_CUSTOMER')


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def _log_call(entry: dict) -> None:
    job_dir = os.environ.get('DESIGN_AGENT_JOB_DIR')
    if not job_dir:
        return
    entry = {'at': datetime.now().isoformat(timespec='seconds'), **entry}
    try:
        with open(Path(job_dir) / 'api-calls.jsonl', 'a', encoding='utf-8') as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else ''
    rest = args[1:]
    entry: dict = {'cmd': cmd, 'taskKey': None, 'status': 0}

    def usage_error(text: str = USAGE) -> int:
        _log_call(entry)
        _emit({'ok': False, 'error': text})
        return 2

    mockup = False
    if cmd == 'upload' and '--mockup' in rest:
        mockup = True
        rest = [a for a in rest if a != '--mockup']
    shapes = {'upload': 3, 'submit': 1, 'reopen': 3, 'note': 2, 'download': 2}
    if cmd not in shapes or len(rest) != shapes[cmd]:
        return usage_error()
    if cmd != 'download':
        entry['taskKey'] = rest[0]
    else:
        entry['artworkId'] = rest[0]
    if cmd == 'upload':
        entry.update(printArea=rest[1], file=rest[2])
        path = Path(rest[2])
        if not path.is_file():
            return usage_error(f'không thấy file {rest[2]}')
        if path.stat().st_size == 0:
            return usage_error(f'file rỗng: {rest[2]}')

    cfg_path = env_path()
    try:
        cfg = read_env(cfg_path)
    except OSError:
        cfg = {}
    url, token = cfg.get('ECOM_URL', ''), cfg.get('DESIGN_AGENT_TOKEN', '')
    if not url or not token:
        return usage_error(f'thiếu ECOM_URL hoặc DESIGN_AGENT_TOKEN trong {cfg_path}')
    try:
        client = AgentApi(url, token)
    except ValueError as exc:
        return usage_error(str(exc))

    try:
        if cmd == 'upload':
            reply = client.upload(rest[0], rest[1], Path(rest[2]), mockup=mockup)
        elif cmd == 'submit':
            reply = client.submit(rest[0])
        elif cmd == 'reopen':
            reply = client.reopen(rest[0], rest[1], rest[2])
            status = reply.get('status')
            if status in REOPENED:
                reply = {**reply, 'reopened': True}
            elif status in NOT_REOPENED:
                reply = {**reply, 'reopened': False, 'message': f'task đang {status}, chưa duyệt nên không cần mở lại'}
            else:
                entry['status'] = 200
                _log_call(entry)
                _emit({'ok': False, 'status': 200, 'error': f'máy chủ trả trạng thái không hợp lệ sau reopen: {status!r}'})
                return 1
        elif cmd == 'note':
            reply = client.note(rest[0], rest[1])
        else:
            size = client.download(rest[0], Path(rest[1]))
            reply = {'ok': True, 'bytes': size, 'path': rest[1]}
    except ApiError as exc:
        entry['status'] = exc.status or 0
        _log_call(entry)
        if exc.status is None:
            _emit({'ok': False, 'error': exc.body.get('error') or 'không kết nối được máy chủ'})
            return 3
        extra = {k: v for k, v in exc.body.items() if k not in ('ok', 'status', 'error')}
        _emit({'ok': False, 'status': exc.status, 'error': exc.body.get('error') or f'HTTP {exc.status}', **extra})
        return 1
    except OSError as exc:
        _log_call(entry)
        _emit({'ok': False, 'error': f'lỗi file: {type(exc).__name__}'})
        return 2
    entry['status'] = 200
    _log_call(entry)
    _emit(reply)
    return 0


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
