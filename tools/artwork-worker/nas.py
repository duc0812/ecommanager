"""PSD folders on the office NAS (ARTWORK_NAS_ROOT).

The server lists one slot per product x template x option; this module makes sure each slot has its folder, finds the
PSD a designer dropped in it (the newest .psd/.psb; older ones move to _old/), and reports path + sha256 back.
The server then queues a parse job only for a new or changed PSD; the parse job reads the file straight from the NAS.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

PSD_EXT = ('.psd', '.psb')
OLD_DIR = '_old'
CHUNK = 1024 * 1024


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(CHUNK), b''):
            h.update(chunk)
    return h.hexdigest()


class HashCache:
    """sha256 by (path, size, mtime): a 70 MB PSD over the LAN is hashed once, not on every scan."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            self.data = {}

    def get(self, file: Path) -> str:
        st = file.stat()
        key = str(file)
        hit = self.data.get(key)
        if hit and hit.get('size') == st.st_size and hit.get('mtime') == st.st_mtime:
            return hit['sha256']
        digest = sha256_file(file)
        self.data[key] = {'size': st.st_size, 'mtime': st.st_mtime, 'sha256': digest}
        return digest

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data, ensure_ascii=False), encoding='utf-8')
        except OSError:
            pass


def slot_dir(root: Path, slot: dict) -> Path:
    """The slot's folder. A product folder already named "<productKey> ..." is reused, so renaming a product on Shopify
    (or tidying the folder name by hand) never splits its PSDs over two folders."""
    folder = [str(s) for s in slot.get('folder') or []]
    if slot.get('nasPath') or len(folder) != 3:
        return root.joinpath(*folder)
    store, product, sub = folder
    key = str(slot.get('productKey') or '')
    store_dir = root / store
    if key and store_dir.is_dir():
        for child in sorted(store_dir.iterdir()):
            if child.is_dir() and (child.name == key or child.name.startswith(key + ' ')):
                return child / sub
    return store_dir / product / sub


def psds_in(folder: Path) -> list[Path]:
    """PSDs directly in the folder, newest first (Photoshop's ~ temp files skipped)."""
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in PSD_EXT and not p.name.startswith(('~', '.'))]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def retire(files: list[Path], folder: Path) -> list[Path]:
    """Move superseded PSDs into _old/, never overwriting one already there."""
    old = folder / OLD_DIR
    old.mkdir(exist_ok=True)
    moved = []
    for f in files:
        dest = old / f.name
        if dest.exists():
            stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime(f.stat().st_mtime))
            dest = old / f'{f.stem}-{stamp}{f.suffix}'
        shutil.move(str(f), str(dest))
        moved.append(dest)
    return moved


def upload_name(raw: str) -> str:
    """The uploaded file's own name, made safe for a Windows folder; always .psd/.psb."""
    name = ''.join(' ' if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in Path(str(raw)).name).strip().rstrip('. ')
    if not name.lower().endswith(PSD_EXT):
        name = (name or 'artwork') + '.psd'
    return name


def pull_upload(api, folder: Path, pending: dict, hashes: HashCache, log: Callable[[str], None]) -> Path:
    """Download a PSD a designer uploaded in the tool into the slot folder, where it becomes the newest PSD (the scan below
    then retires the previous one to _old and reports it; the server deletes the uploaded copy once linked)."""
    name = upload_name(pending.get('fileName') or 'artwork.psd')
    part = folder / f'.{name}.part'
    sha = api.download(str(pending['fileId']), str(part), pending.get('sha256'))
    dest = folder / name
    if dest.exists():
        retire([dest], folder)
    os.replace(part, dest)
    st = dest.stat()
    hashes.data[str(dest)] = {'size': st.st_size, 'mtime': st.st_mtime, 'sha256': sha}
    log(f'  pulled upload {name} ({st.st_size / 1048576:.1f} MB) into {folder.name}')
    return dest


def scan(api, root: Path, hashes: HashCache, log: Callable[[str], None]) -> dict:
    if not root.is_dir():
        raise OSError(f'NAS root {root} is not reachable')
    slots = api.nas_slots()
    found, missing, created, retired, pulled, errors = [], [], 0, 0, 0, []
    seen: set[str] = set()
    for s in slots:
        folder = slot_dir(root, s)
        if not folder.is_dir():
            folder.mkdir(parents=True, exist_ok=True)
            created += 1
            log(f'  created {folder.relative_to(root).as_posix()}')
        if s.get('pendingUpload'):
            try:
                pull_upload(api, folder, s['pendingUpload'], hashes, log)
                pulled += 1
            except Exception as e:  # one bad upload must not stop the scan
                errors.append(f'{folder.relative_to(root).as_posix()}: không kéo được PSD upload ({e})')
                for leftover in folder.glob('.*.part'):
                    leftover.unlink(missing_ok=True)
        files = psds_in(folder)
        if len(files) > 1:
            moved = retire(files[1:], folder)
            retired += len(moved)
            log(f'  {folder.relative_to(root).as_posix()}: moved {len(moved)} older PSD(s) to {OLD_DIR}/')
        if not files:
            if s.get('nasPath') and s['nasPath'] not in seen:
                missing.append(s['nasPath'])
            continue
        psd = files[0]
        rel = psd.relative_to(root).as_posix()
        seen.add(rel)
        st = psd.stat()
        found.append({
            'storeId': s['storeId'], 'shopifyProductId': s['shopifyProductId'], 'templateId': s['templateId'],
            'optionKey': s.get('optionKey') or '', 'nasPath': rel, 'sha256': hashes.get(psd), 'size': st.st_size,
            'modifiedAt': datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        })
    hashes.save()
    missing = [m for m in missing if m not in seen]
    resp = api.nas_report({'root': str(root), 'found': found, 'missing': missing})
    return {'slots': len(slots), 'created': created, 'retired': retired, 'found': len(found), 'missing': missing, 'pulled': pulled,
            'queued': resp.get('queued') or [], 'linked': resp.get('linked') or [], 'errors': errors + (resp.get('errors') or [])}


def nas_root() -> Path | None:
    raw = os.environ.get('ARTWORK_NAS_ROOT', '').strip()
    return Path(raw) if raw else None


def copy_psd(root: Path, rel: str, dest: str, expect_sha256: str | None) -> str:
    """Copy a NAS PSD to a local temp file (the parser reads it many times), verifying it is the file the job was queued for."""
    src = root.joinpath(*rel.split('/'))
    if not src.is_file():
        raise FileNotFoundError(f'PSD không còn trên NAS: {rel}')
    h = hashlib.sha256()
    with open(src, 'rb') as fin, open(dest, 'wb') as fout:
        for chunk in iter(lambda: fin.read(CHUNK), b''):
            fout.write(chunk)
            h.update(chunk)
    digest = h.hexdigest()
    if expect_sha256 and digest.lower() != expect_sha256.lower():
        raise ChangedError(f'PSD trên NAS đã đổi từ lúc quét ({rel}) — lần quét sau sẽ xếp đọc lại')
    return digest


class ChangedError(Exception):
    pass
