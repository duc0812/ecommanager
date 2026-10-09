"""Machine API client for /api/design-studio/worker/* (shapes mirror src/lib/artwork-worker.ts).

POST worker/claim {"kinds": [...]} -> {"job": null}, a PARSE_PSD claim or a RENDER_LINE claim (below)
GET  worker/files/<id>           -> raw bytes (PSD or font), header X-Content-SHA256
GET  worker/fonts                -> {"fonts": [{postscriptName, fileId, sha256, family, style, fileName, size}]}
POST worker/jobs/<id>/result     -> PARSE_PSD: multipart artwork (artwork.png), preview (preview.png), result (result.json)
                                    -> {"ok": true, "status": "...", "entryId": "..."}
                                    RENDER_LINE: multipart print (print.png), preview (preview.jpg), result (result.json)
                                    -> {"ok": true, "status": "DONE", "artworkId": "...", "version": n, "warning": str|null}
POST worker/jobs/<id>/fail       -> JSON {"error": str, "permanent": bool} -> {"ok", "jobStatus", "attempts"}
All requests carry `Authorization: Bearer <DESIGN_WORKER_TOKEN>`. The token is never logged.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any

import requests

TIMEOUT = (15, 300)
PARSE_PSD = 'PARSE_PSD'
RENDER_LINE = 'RENDER_LINE'
KINDS = [PARSE_PSD, RENDER_LINE]
CHUNK = 1024 * 1024


@dataclass
class Template:
    id: str
    name: str
    widthPx: int
    heightPx: int
    dpi: int
    areas: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {'widthPx': self.widthPx, 'heightPx': self.heightPx, 'dpi': self.dpi, 'areas': self.areas}


@dataclass
class Claim:
    job_id: str
    attempts: int
    entry_id: str
    entry_title: str
    template: Template
    psd_file_id: str
    psd_file_name: str
    psd_size: int
    psd_sha256: str | None
    layer_fields: dict[str, str] = field(default_factory=dict)
    kind: str = PARSE_PSD


@dataclass
class RenderClaim:
    """RENDER_LINE: draw the customer's values onto the entry's artwork.png at template size."""
    job_id: str
    attempts: int
    entry_id: str
    entry_title: str
    template: Template
    fields: list[dict]
    artwork_file_id: str
    artwork_sha256: str | None
    values: dict[str, str]
    target: dict
    kind: str = RENDER_LINE


@dataclass
class FontRef:
    postscriptName: str
    fileId: str
    sha256: str
    fileName: str = ''


def _template(tpl: dict) -> Template:
    areas = tpl.get('areas') or []
    if isinstance(areas, str):
        try:
            areas = json.loads(areas)
        except ValueError:
            areas = []
    return Template(id=tpl.get('id', ''), name=tpl.get('name', ''), widthPx=int(tpl['widthPx']),
                    heightPx=int(tpl['heightPx']), dpi=int(tpl.get('dpi') or 300), areas=list(areas))


def parse_claim(data: dict | None) -> Claim | RenderClaim | None:
    if not data or not data.get('job'):
        return None
    job, entry, tpl = data['job'], data.get('entry') or {}, data.get('template') or {}
    if job.get('kind') == RENDER_LINE:
        art = data.get('artwork') or {}
        return RenderClaim(
            job_id=job['id'], attempts=int(job.get('attempts') or 0), entry_id=entry.get('id', ''),
            entry_title=entry.get('title', ''), template=_template(tpl), fields=list(entry.get('fields') or []),
            artwork_file_id=art.get('id', ''), artwork_sha256=art.get('sha256'),
            values={str(k): str(v) for k, v in (data.get('values') or {}).items()}, target=dict(data.get('target') or {}),
        )
    psd = data.get('psd') or {}
    lf = entry.get('layerFields') or {}
    return Claim(
        job_id=job['id'], attempts=int(job.get('attempts') or 0),
        entry_id=entry.get('id', ''), entry_title=entry.get('title', ''),
        template=_template(tpl),
        psd_file_id=data.get('psdFileId') or psd.get('id'), psd_file_name=psd.get('fileName', 'artwork.psd'),
        psd_size=int(psd.get('size') or 0), psd_sha256=psd.get('sha256'),
        layer_fields={str(k): str(v) for k, v in lf.items()} if isinstance(lf, dict) else {},
    )


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class WorkerApi:
    def __init__(self, base_url: str, token: str):
        if not base_url or not token:
            raise ValueError('ECOM_URL and DESIGN_WORKER_TOKEN are required')
        self.base = base_url.rstrip('/') + '/api/design-studio/worker'
        self.s = requests.Session()
        self.s.headers['Authorization'] = f'Bearer {token}'
        self.s.headers['User-Agent'] = 'artwork-worker/1'

    def __repr__(self) -> str:
        return f'WorkerApi({self.base!r})'

    def _check(self, r: requests.Response, what: str) -> requests.Response:
        if r.status_code >= 400:
            try:
                msg = r.json().get('error') or r.text[:300]
            except ValueError:
                msg = r.text[:300]
            raise ApiError(f'{what}: HTTP {r.status_code} {msg}', r.status_code)
        return r

    def claim(self, kinds: list[str] | None = None) -> Claim | RenderClaim | None:
        r = self._check(self.s.post(f'{self.base}/claim', json={'kinds': kinds or KINDS}, timeout=TIMEOUT), 'claim')
        if r.status_code == 204 or not r.content:
            return None
        return parse_claim(r.json())

    def fonts(self) -> list[FontRef]:
        data = self._check(self.s.get(f'{self.base}/fonts', timeout=TIMEOUT), 'fonts').json()
        rows = data.get('fonts', []) if isinstance(data, dict) else data
        return [FontRef(postscriptName=f['postscriptName'], fileId=f['fileId'], sha256=f.get('sha256', ''),
                        fileName=f.get('fileName', '')) for f in rows]

    def download(self, file_id: str, dest: str, expect_sha256: str | None = None) -> str:
        """Stream a library file to `dest`, verifying sha256 when known. Returns the sha256."""
        h = hashlib.sha256()
        with self.s.get(f'{self.base}/files/{file_id}', timeout=TIMEOUT, stream=True) as r:
            self._check(r, f'download {file_id}')
            expect = expect_sha256 or r.headers.get('X-Content-SHA256')
            with open(dest, 'wb') as fh:
                for chunk in r.iter_content(CHUNK):
                    fh.write(chunk)
                    h.update(chunk)
        digest = h.hexdigest()
        if expect and digest.lower() != expect.lower():
            os.remove(dest)
            raise ApiError(f'download {file_id}: sha256 mismatch')
        return digest

    def submit_result(self, job_id: str, result: dict, artwork_png: bytes, preview_png: bytes | None) -> dict:
        files: list[tuple[str, tuple[str, Any, str]]] = [
            ('result', ('result.json', json.dumps(result, ensure_ascii=False).encode('utf-8'), 'application/json')),
            ('artwork', ('artwork.png', artwork_png, 'image/png')),
        ]
        if preview_png is not None:
            files.append(('preview', ('preview.png', preview_png, 'image/png')))
        r = self.s.post(f'{self.base}/jobs/{job_id}/result', files=files, timeout=TIMEOUT)
        return self._check(r, 'result').json()

    def submit_render(self, job_id: str, result: dict, print_png: bytes, preview_jpg: bytes | None) -> dict:
        files: list[tuple[str, tuple[str, Any, str]]] = [
            ('result', ('result.json', json.dumps(result, ensure_ascii=False).encode('utf-8'), 'application/json')),
            ('print', ('print.png', print_png, 'image/png')),
        ]
        if preview_jpg is not None:
            files.append(('preview', ('preview.jpg', preview_jpg, 'image/jpeg')))
        r = self.s.post(f'{self.base}/jobs/{job_id}/result', files=files, timeout=TIMEOUT)
        return self._check(r, 'result').json()

    def fail(self, job_id: str, error: str, permanent: bool = False) -> dict:
        r = self.s.post(f'{self.base}/jobs/{job_id}/fail', json={'error': error[:2000] or 'error', 'permanent': permanent},
                        timeout=TIMEOUT)
        return self._check(r, 'fail').json()
