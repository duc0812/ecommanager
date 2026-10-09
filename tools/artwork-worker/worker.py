"""Artwork Library parse worker: claims PARSE_PSD jobs from Ecom Manager and parses them locally.

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

from api import ApiError, Claim, FontRef, WorkerApi
from parse_psd import ParseError, parse

CACHE_DIR = Path(os.environ.get('ARTWORK_WORKER_HOME') or Path.home() / '.artwork-worker')


def log(msg: str) -> None:
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


class FontCache:
    """Library fonts cached by content hash under ~/.artwork-worker/fonts/<sha256>."""

    def __init__(self, api: WorkerApi, root: Path = CACHE_DIR / 'fonts'):
        self.api = api
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.index: dict[str, FontRef] = {}

    def refresh(self) -> None:
        self.index = {f.postscriptName.lower(): f for f in self.api.fonts()}

    def lookup(self, postscript: str) -> str | None:
        ref = self.index.get((postscript or '').lower())
        if ref is None:
            return None
        if ref.sha256:
            path = self.root / ref.sha256.lower()
            if path.exists():
                return str(path)
        tmp = self.root / f'.{ref.fileId}.part'
        digest = self.api.download(ref.fileId, str(tmp), ref.sha256 or None)
        path = self.root / digest
        os.replace(tmp, path)
        log(f'  font {ref.postscriptName} cached')
        return str(path)


def _png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=6)
    return buf.getvalue()


def process(api: WorkerApi, fonts: FontCache, claim: Claim, debug_dir: str | None = None) -> None:
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


def _fail(api: WorkerApi, claim: Claim, error: str, permanent: bool = False) -> None:
    try:
        r = api.fail(claim.job_id, error, permanent=permanent)
        log(f'  reported failure -> job {r.get("jobStatus")} (attempts {r.get("attempts")})')
    except Exception as e:  # noqa: BLE001
        log(f'  could not report failure: {e}')


def run(once: bool, poll: float, debug_dir: str | None) -> int:
    api = WorkerApi(os.environ.get('ECOM_URL', ''), os.environ.get('DESIGN_WORKER_TOKEN', ''))
    fonts = FontCache(api)
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
        process(api, fonts, claim, debug_dir)
        if once:
            return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='Artwork Library PSD parse worker')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--once', action='store_true', help='process at most one job and exit')
    g.add_argument('--poll', type=float, metavar='SECONDS', help='loop forever, sleeping SECONDS when idle')
    ap.add_argument('--debug-dir', help='also save reference.png / check.png per job here')
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
