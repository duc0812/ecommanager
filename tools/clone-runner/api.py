"""Client for /api/clone-worker/* on Ecom Manager. Standard library only.

POST claim                {"waitSeconds": 25}                       -> {"job": claim | null, "paused": bool}
POST jobs/<id>/heartbeat  {"attempts", "stage"?, "platform"?}        -> {"ok": bool, "cancelled": bool}
POST jobs/<id>/result     {"attempts", "productGid", "handle"?, "qaVerdict", "qaNote"?, "reused"?, "costUsd"?,
                           "durationMs"?}                            -> 200 {"status", "error"?} | 502 {"error"} | 404
POST jobs/<id>/fail       {"attempts", "failKind", "error", "productGid"?, "retryable"?} -> {"status"}

Every request carries `Authorization: Bearer <CLONE_WORKER_TOKEN>`. The token never appears in an error or log line.
"""
from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.parse
import urllib.request

CLAIM_TIMEOUT_S = 40
TIMEOUT_S = 30
MAX_ERROR_CHARS = 2000
FAIL_KINDS = ('UNSUPPORTED', 'NOT_ENABLED', 'SOURCE', 'TOOL', 'TOOL_GAP', 'QA', 'TIMEOUT')


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class NetworkError(ApiError):
    pass


class AuthError(ApiError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Following a redirect would resend the Authorization header to wherever it points.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base_url: str, token: str, opener=None):
        if not base_url or not token:
            raise ValueError('ECOM_URL and CLONE_WORKER_TOKEN are required')
        self._base = base_url.rstrip('/') + '/api/clone-worker'
        self._token = token
        self._opener = opener or urllib.request.build_opener(NoRedirect())

    def __repr__(self) -> str:
        return f'Client({self._base!r})'

    def _scrub(self, text: str) -> str:
        return text.replace(self._token, '***')

    def _post(self, what: str, path: str, body: dict, timeout: int) -> tuple[int, dict]:
        req = urllib.request.Request(
            self._base + path,
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            method='POST',
            headers={
                'Authorization': f'Bearer {self._token}',
                'Content-Type': 'application/json',
                'User-Agent': 'clone-runner/1',
            },
        )
        try:
            try:
                with self._opener.open(req, timeout=timeout) as resp:
                    status, raw = resp.status, resp.read()
            except urllib.error.HTTPError as e:
                status, raw = e.code, e.read()
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            reason = getattr(e, 'reason', None) or e
            raise NetworkError(self._scrub(f'{what}: {type(e).__name__}: {reason}')[:500]) from None
        if status == 401:
            raise AuthError(f'{what}: HTTP 401', 401)
        try:
            data = json.loads(raw.decode('utf-8')) if raw else {}
        except ValueError:
            data = {}
        return status, data if isinstance(data, dict) else {}

    def _ok(self, what: str, path: str, body: dict, timeout: int = TIMEOUT_S) -> dict:
        status, data = self._post(what, path, body, timeout)
        if status != 200:
            raise ApiError(self._scrub(f'{what}: HTTP {status} {data.get("error") or ""}'.strip())[:500], status)
        return data

    @staticmethod
    def _job(job_id, action: str) -> str:
        return f'/jobs/{urllib.parse.quote(str(job_id), safe="")}/{action}'

    def claim(self, wait_seconds: int = 25) -> dict:
        return self._ok('claim', '/claim', {'waitSeconds': wait_seconds}, CLAIM_TIMEOUT_S)

    def heartbeat(self, job_id, attempts, stage: str | None = None, platform: str | None = None) -> dict:
        body = {'attempts': attempts}
        if stage is not None:
            body['stage'] = stage
        if platform is not None:
            body['platform'] = platform
        return self._ok('heartbeat', self._job(job_id, 'heartbeat'), body)

    def result(self, job_id, attempts, payload: dict) -> tuple[int, dict]:
        return self._post('result', self._job(job_id, 'result'), {'attempts': attempts, **payload}, TIMEOUT_S)

    def fail(self, job_id, attempts, fail_kind: str, error: str, retryable: bool = False,
             product_gid: str | None = None) -> dict:
        body = {'attempts': attempts, 'failKind': fail_kind, 'error': (error or 'error')[:MAX_ERROR_CHARS]}
        if product_gid:
            body['productGid'] = product_gid
        if retryable:
            body['retryable'] = True
        return self._ok('fail', self._job(job_id, 'fail'), body)
