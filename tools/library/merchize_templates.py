"""Download Merchize's own print templates and mockup PSDs into the design library.

    python tools/library/merchize_templates.py --catalog merchize_catalog.json            # dry run: list what would come
    python tools/library/merchize_templates.py --catalog merchize_catalog.json --apply

The catalog is the Merchize API dump (GET /product/catalog, every page); each blank's `mockup_and_templates_link` is a
public Drive folder. It is walked recursively (anonymous embeddedfolderview) and copied to
LIBRARY\\templates\\<Product Type>\\MERCHIZE - <BLANK>\\template\\… or …\\mockup\\… (any path with "mockup" in it). Folders named "old" are
skipped. blank.json keeps the catalog data and, for blanks Jomall prints on the same template, a note saying so.
Idempotent: a file already there with the same size is skipped.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from library_paths import blank_dir  # noqa: E402

ROOT_DEFAULT = r'\\TMTEAM\TEMPLATE\LIBRARY'
UA = {'User-Agent': 'Mozilla/5.0 (design-library)'}
ENTRY_RE = re.compile(r'href="https://drive\.google\.com/(file/d|drive/folders)/([A-Za-z0-9_-]+)[^"]*"[^>]*>.*?flip-entry-title">([^<]+)<', re.S)

# Merchize blanks this shop sells through Merchize itself
OWN = ['11AMUS', '11MMUS', '15AMUS', '18600US', '5000US', 'CSAMVN', 'EBSSVN', 'FEBOVN', 'LFBKUS', 'MWHDVN', 'MWSSVN', 'PCAOVN', 'QTFHVN',
       'WAORVN', 'WSTRVN']
# Merchize blanks whose template Jomall uses for its own product (checked = confirmed on an order; else a candidate to verify)
JOMALL = {
    'KNCAVN': ('V-NECK (Cardigan)', True), 'BAJEVN': ('TBEJ (Baseball Jersey)', True), 'KYBJVN': ('KID / TODDLER baseball T-shirts', True),
    'MWHDVN': ('PULLOVER-HOODIE (AOP)', True), 'PASEVN': ('FULL-SET / ONLY-SHIRT / ONLY-PANTS (3D Print Pajama)', False),
    'MWZHVN': ('ZIP-HOODIE (AOP)', False), 'MWSSVN': ('SWEATSHIRTS (AOP)', False), 'T5HAVN': ('TSHIRT (AOP)', False),
    'RHWSVN': ('ECY (Hawaiian Shirt)', False), 'HWS2VN': ('STK (Beach Shorts)', False), 'KNSWVN': ('CREWNECK (Cardigan) — so khổ trước khi dùng', False),
}


def get(url: str) -> bytes:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 + attempt * 3)
    return b''


def walk(folder_id: str, path: tuple[str, ...] = (), depth: int = 0):
    if depth > 6:
        return
    page = get(f'https://drive.google.com/embeddedfolderview?id={folder_id}').decode('utf-8', 'replace')
    for kind, fid, title in ENTRY_RE.findall(page):
        title = html.unescape(title).strip()
        if kind == 'drive/folders':
            if re.search(r'\bold\b', title, re.I):
                continue
            yield from walk(fid, path + (title,), depth + 1)
        else:
            yield path, title, fid


def safe(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', '_', name).strip(' .') or 'file'


def download(fid: str, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + '.part')
    with urllib.request.urlopen(urllib.request.Request(f'https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t', headers=UA), timeout=600) as r, open(tmp, 'wb') as fh:
        shutil.copyfileobj(r, fh, 1 << 20)
    head = tmp.read_bytes()[:200] if tmp.stat().st_size < 4096 else b''
    if b'<html' in head.lower():
        tmp.unlink(missing_ok=True)
        raise OSError('Drive answered with a page instead of the file (not public?)')
    tmp.replace(dest)
    return dest.stat().st_size


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', type=Path, required=True)
    ap.add_argument('--root', default=ROOT_DEFAULT)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--only', default='', help='comma-separated SKUs (default: OWN + JOMALL)')
    a = ap.parse_args(argv)
    catalog = {p['sku']: p for p in json.loads(a.catalog.read_text(encoding='utf-8'))}
    skus = [s.strip() for s in a.only.split(',') if s.strip()] or list(dict.fromkeys(OWN + list(JOMALL)))
    root = Path(a.root)
    total = fails = got = 0
    report = [f'# Merchize templates — {"APPLY" if a.apply else "DRY RUN"} — {dt.datetime.now():%Y-%m-%d %H:%M}']
    for sku in skus:
        p = catalog.get(sku)
        if not p or not p.get('mockup_and_templates_link'):
            report.append(f'- {sku}: không có trong catalog hoặc không có link template')
            continue
        m = re.search(r'folders/([A-Za-z0-9_-]+)', p['mockup_and_templates_link'])
        if not m:
            report.append(f'- {sku}: link không phải thư mục Drive: {p["mockup_and_templates_link"]}')
            continue
        files = list(walk(m.group(1)))
        blank = blank_dir(root, 'MERCHIZE', sku)
        rows = []
        for path, title, fid in files:
            sub = 'mockup' if any('mockup' in s.lower() for s in path + (title,)) else 'template'
            dest = blank.joinpath(sub, *[safe(s) for s in path], safe(title))
            rows.append({'file': str(dest.relative_to(blank)).replace('\\', '/'), 'driveFileId': fid})
            total += 1
            if not a.apply or dest.exists():
                continue
            try:
                got += download(fid, dest)
            except Exception as e:  # noqa: BLE001 - one file must not stop the blank
                fails += 1
                report.append(f'  ! {sku} {title}: {e}')
        jomall = JOMALL.get(sku)
        meta = {
            'supplier': 'MERCHIZE', 'blank': sku, 'title': p.get('title'), 'fulfillment': (p.get('fulfillment_location') or {}).get('code'),
            'productionTime': p.get('production_time'), 'attributes': p.get('attributes'), 'variants': p.get('variants_count'),
            'templatesLink': p.get('mockup_and_templates_link'), 'files': rows, 'status': 'UNCHECKED',
            'jomall': {'product': jomall[0], 'confirmed': jomall[1]} if jomall else None,
            'downloadedAt': dt.datetime.now().isoformat(timespec='seconds'),
        }
        if a.apply:
            blank.mkdir(parents=True, exist_ok=True)
            (blank / 'blank.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
        tpl = sum(1 for r in rows if r['file'].startswith('template/'))
        report.append(f'- {sku} {p.get("title")}: {tpl} template, {len(rows) - tpl} mockup' + (f' · Jomall: {jomall[0]}{"" if jomall[1] else " (cần kiểm)"}' if jomall else ''))
    report.append(f'\n{total} file(s); {"downloaded " + str(round(got / 1e9, 2)) + " GB" if a.apply else "dry run"}; failed {fails}')
    text = '\n'.join(report)
    print(text)
    if a.apply:
        rep = Path(a.root) / '_reports' / f'merchize-templates-{dt.datetime.now():%Y%m%d-%H%M}.md'
        rep.parent.mkdir(parents=True, exist_ok=True)
        rep.write_text(text + '\n', encoding='utf-8')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
