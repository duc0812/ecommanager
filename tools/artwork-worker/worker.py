"""Artwork Library worker: claims PARSE_PSD and RENDER_LINE jobs from Ecom Manager and runs them locally.

    set ECOM_URL=http://localhost:3002
    set DESIGN_WORKER_TOKEN=dsw_...
    python worker.py --once        # one job (if any), then exit
    python worker.py --poll 10     # loop, sleeping 10 s when the queue is empty
"""
from __future__ import annotations

import argparse
import io
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image

from api import ApiError, Claim, FontRef, RenderClaim, WorkerApi
from parse_psd import ParseError, parse
from render_line import RenderError, preview_jpg, print_png, render_line

CACHE_DIR = Path(os.environ.get('ARTWORK_WORKER_HOME') or Path.home() / '.artwork-worker')


def log(msg: str) -> None:
    line = f'[{time.strftime("%H:%M:%S")}] {msg}'
    try:
        print(line, flush=True)
    except UnicodeEncodeError:  # Windows console code page vs customer names / Vietnamese messages
        print(line.encode('ascii', 'backslashreplace').decode('ascii'), flush=True)


class FontCache:
    """Library fonts cached by content hash under ~/.artwork-worker/fonts/<sha256>."""

    def __init__(self, api: WorkerApi, root: Path = CACHE_DIR / 'fonts'):
        self.api = api
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.index: dict[str, FontRef] = {}
        self.resolved: dict[str, str] = {}

    def refresh(self) -> None:
        self.index = {f.postscriptName.lower(): f for f in self.api.fonts()}
        self.resolved = {}

    def lookup(self, postscript: str) -> str | None:
        key = (postscript or '').lower()
        if key in self.resolved:
            return self.resolved[key]
        path = self._fetch(key)
        if path:
            self.resolved[key] = path
        return path

    def _fetch(self, key: str) -> str | None:
        ref = self.index.get(key)
        if ref is None:
            return None
        if ref.sha256:
            path = self.root / ref.sha256.lower()
            if path.exists():
                return str(path)
        tmp = self.root / f'.{ref.fileId}.part'
        digest = self.api.download(ref.fileId, str(tmp), ref.sha256 or None)
        path = self.root / digest
        if path.exists():  # same content cached under its hash already (and maybe open in FreeType)
            os.remove(tmp)
        else:
            os.replace(tmp, path)
            log(f'  font {ref.postscriptName} cached')
        return str(path)


class ArtworkCache:
    """Entry artwork.png files cached by content hash: many orders reuse one entry."""

    def __init__(self, api: WorkerApi, root: Path = CACHE_DIR / 'artwork'):
        self.api = api
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def get(self, file_id: str, sha256: str | None) -> str:
        if sha256:
            path = self.root / sha256.lower()
            if path.exists():
                return str(path)
        tmp = self.root / f'.{file_id}.part'
        digest = self.api.download(file_id, str(tmp), sha256 or None)
        path = self.root / digest
        if path.exists():
            os.remove(tmp)
        else:
            os.replace(tmp, path)
        return str(path)


def _png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=6)
    return buf.getvalue()


def process(api: WorkerApi, fonts: FontCache, claim: Claim | RenderClaim, debug_dir: str | None = None,
            artworks: ArtworkCache | None = None) -> None:
    if isinstance(claim, RenderClaim):
        process_render(api, fonts, artworks or ArtworkCache(api), claim, debug_dir)
        return
    t0 = time.time()
    log(f'job {claim.job_id} (attempt {claim.attempts}) entry {claim.entry_id} "{claim.entry_title}" '
        f'template {claim.template.name} {claim.template.widthPx}x{claim.template.heightPx}')
    work = tempfile.mkdtemp(prefix='artwork-job-')
    try:
        psd_path = os.path.join(work, 'input.psd')
        api.download(claim.psd_file_id, psd_path, claim.psd_sha256)
        log(f'  PSD downloaded ({os.path.getsize(psd_path) / 1e6:.1f} MB)')
        fonts.refresh()
        result, artwork, preview = parse(psd_path, claim.template.as_dict(), fonts.lookup,
                                         custom_layers=claim.layer_fields or None,
                                         debug_dir=os.path.join(debug_dir, claim.job_id) if debug_dir else None)
        log(f'  parsed: {len(result["fields"])} field(s), status {result["status"]}, '
            f'score {result["checkScore"]}, missing {result["missingFonts"]}, {len(result["warnings"])} warning(s)')
        resp = api.submit_result(claim.job_id, result, _png(artwork), _png(preview))
        log(f'  stored -> {resp.get("status")} ({time.time() - t0:.1f}s)')
    except ParseError as e:
        log(f'  parse error: {e}')
        _fail(api, claim, str(e), permanent=True)
    except ApiError as e:
        log(f'  api error: {e}')
        if e.status != 409:
            _fail(api, claim, str(e))
    except Exception as e:  # noqa: BLE001 - every failure must be reported to the server
        log(f'  failed: {e!r}')
        traceback.print_exc()
        _fail(api, claim, f'{type(e).__name__}: {e}')
    finally:
        shutil.rmtree(work, ignore_errors=True)


def process_render(api: WorkerApi, fonts: FontCache, artworks: ArtworkCache, claim: RenderClaim,
                   debug_dir: str | None = None) -> None:
    t0 = time.time()
    tgt = claim.target
    log(f'job {claim.job_id} RENDER_LINE (attempt {claim.attempts}) {tgt.get("orderNumber")} line {tgt.get("linePosition")} '
        f'-> {tgt.get("printArea")} from entry {claim.entry_id} "{claim.entry_title}"')
    try:
        art_path = artworks.get(claim.artwork_file_id, claim.artwork_sha256)
        fonts.refresh()
        with Image.open(art_path) as im:
            artwork = im.convert('RGBA')
        img, preview, info = render_line(artwork, claim.fields, claim.values, fonts.lookup, claim.template.as_dict())
        png = print_png(img, claim.template.dpi)
        if debug_dir:
            os.makedirs(debug_dir, exist_ok=True)
            with open(os.path.join(debug_dir, f'{claim.job_id}-print.png'), 'wb') as fh:
                fh.write(png)
        sizes = ', '.join(f'{d["value"]} {d["sizePx"]:.0f}px' for d in info['fields'])
        log(f'  rendered {info["widthPx"]}x{info["heightPx"]} ({sizes}), {len(info["warnings"])} warning(s)')
        resp = api.submit_render(claim.job_id, info, png, preview_jpg(preview))
        log(f'  stored -> artwork v{resp.get("version")} ({time.time() - t0:.1f}s)')
    except RenderError as e:
        log(f'  render error: {e}')
        _fail(api, claim, str(e), permanent=True)
    except ApiError as e:
        log(f'  api error: {e}')
        if e.status != 409:
            _fail(api, claim, str(e))
    except Exception as e:  # noqa: BLE001 - every failure must be reported to the server
        log(f'  failed: {e!r}')
        traceback.print_exc()
        _fail(api, claim, f'{type(e).__name__}: {e}')


def _fail(api: WorkerApi, claim: Claim | RenderClaim, error: str, permanent: bool = False) -> None:
    try:
        r = api.fail(claim.job_id, error, permanent=permanent)
        log(f'  reported failure -> job {r.get("jobStatus")} (attempts {r.get("attempts")})')
    except Exception as e:  # noqa: BLE001
        log(f'  could not report failure: {e}')


def run(once: bool, poll: float, debug_dir: str | None) -> int:
    api = WorkerApi(os.environ.get('ECOM_URL', ''), os.environ.get('DESIGN_WORKER_TOKEN', ''))
    fonts = FontCache(api)
    artworks = ArtworkCache(api)
    log(f'worker started against {os.environ.get("ECOM_URL")}')
    while True:
        try:
            claim = api.claim()
        except (ApiError, OSError) as e:
            log(f'claim failed: {e}')
            if once:
                return 1
            time.sleep(poll)
            continue
        if claim is None:
            if once:
                log('no job queued')
                return 0
            time.sleep(poll)
            continue
        process(api, fonts, claim, debug_dir, artworks)
        if once:
            return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='Artwork Library worker (PSD parse + per-order print render)')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--once', action='store_true', help='process at most one job and exit')
    g.add_argument('--poll', type=float, metavar='SECONDS', help='loop forever, sleeping SECONDS when idle')
    ap.add_argument('--debug-dir', help='also save reference.png / check.png (parse) or <job>-print.png (render) here')
    a = ap.parse_args(argv)
    try:
        return run(a.once, a.poll or 10.0, a.debug_dir)
    except KeyboardInterrupt:
        log('stopped')
        return 0
    except ValueError as e:
        log(str(e))
        return 2


if __name__ == '__main__':
    sys.exit(main())
