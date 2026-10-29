"""Design library, phase 1: build \\\\TMTEAM\\TEMPLATE\\LIBRARY and COPY what already exists into it (nothing is moved or deleted).

    python tools/library/phase1.py                      # dry run: what would be created / copied, nothing written
    python tools/library/phase1.py --apply              # do it (idempotent: a file already there with the same size is skipped)
    python tools/library/phase1.py --apply --only fonts,suppliers

Steps (docs/superpowers/specs/2026-10-29-design-library-plan.md, section 6):
  skeleton   the folder tree + README
  fonts      every distinct font file (by sha256) on this PC -> _fonts\\<Family>\\<PostScript>.<ext> + fonts.json
  suppliers  supplier templates / cutlines / mockup PSDs listed in supplier_sources.json -> suppliers\\<SUP>\\<BLANK>\\
  psds       the design PSDs of \\\\TMTEAM\\TEMPLATE\\2026\\MERCHIZE -> products\\<CODE>\\artwork\\<CODE>-<V1>-ALL-UNKNOWN-<date>\\master.psd
  flat       the latest approved no-custom print set of every SKU x supplier (export from prod, --flat-json) downloaded
             from Drive -> products\\<CODE>\\artwork\\<CODE>-<V1>-<V2>-<SUP>-<date>\\print\\<AREA>.<ext>
Everything copied in lands with asset.json status UNCHECKED: it still has to pass the tool's checks before reuse.
A report goes to LIBRARY\\_reports\\phase1-<stamp>.md (and is printed).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT_DEFAULT = r'\\TMTEAM\TEMPLATE\LIBRARY'
HERE = Path(__file__).resolve().parent
CODE_RE = re.compile(r'(?<![A-Z0-9])([A-Z]{2}\d{7,10}[A-Z]{0,3})(?![A-Z0-9])', re.I)
LINE_PREFIX_RE = re.compile(r'^LIT\d+(?:_\d+)*\s*(?:-\s*)?', re.I)
SUPPLIER_NAMES = {'MANGOSHAO': 'MANGO', 'MANGO': 'MANGO', 'MERCHIZE': 'MERCHIZE', 'JOMALL': 'JOMALL', 'PGPRINTS': 'PGPRINTS',
                  'PRINTWAY': 'PRINTWAY', 'BONDRE': 'BONDRE', 'PRINTPOSS': 'PRINTPOSS', 'LENFUL': 'LENFUL', 'SNAP_ECOM': 'SNAPECOM'}
FONT_SOURCES = [
    Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'Windows' / 'Fonts',
    Path.home() / '.artwork-worker' / 'fonts',
    Path(r'D:\Ecom manager\artwork-builder'),
    Path(r'D:\Ecom manager\customall-clones'),
    Path(r'D:\Ecom manager\customall-reminiso-clones'),
    Path(r'D:\Ecom manager\clipart-clones'),
    Path(r'D:\Ecom manager\clipart-originals'),
]
PSD_SOURCE = Path(r'\\TMTEAM\TEMPLATE\2026\MERCHIZE')

README = """# THƯ VIỆN THIẾT KẾ

Không chép tay vào đây. Mọi file vào thư viện đi qua tool (Design Studio › Lưu vào thư viện) và bước kiểm tra;
chỉ worker ở máy văn phòng ghi vào thư mục này. Plan: docs/superpowers/specs/2026-10-29-design-library-plan.md

_staging\\    file nộp qua tool đang chờ kiểm tra / duyệt
_fonts\\      font dùng trong thiết kế (fonts.json: family, style, postscript, nguồn)
_reports\\    báo cáo của script / worker
suppliers\\<XƯỞNG>\\<BLANK>\\template|mockup\\   template, cutlines, mockup PSD của xưởng
products\\<MÃ SP>\\artwork\\<SKU>-<Variant1>-<Variant2>-<XƯỞNG>-<YYYYMMDD>\\
    print\\     file in phẳng (sản phẩm không custom)
    base\\      file in không có chữ custom + text.json (sản phẩm custom chữ)
    master.psd PSD gốc, layer text tên @<Field>
    asset.json loại asset, trạng thái (UNCHECKED = chép từ dữ liệu cũ, chưa qua kiểm tra), nguồn, font

Tên: viết HOA, không dấu, không khoảng trắng; variant không đổi artwork ghi ALL; xưởng chưa biết ghi UNKNOWN.
Variant chuẩn hóa dần — thư mục cũ giữ tên cho tới khi tool đổi tên.
"""


def norm(s: str | None) -> str:
    s = (s or '').upper().replace('×', 'X')
    s = re.sub(r'[ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ]', 'A', s)
    s = re.sub(r'[^A-Z0-9]+', '', s)
    return s or 'ALL'


def area_name(area: str) -> str:
    """A print area as a file name: BACK HEM -> BACK_HEM."""
    return re.sub(r'[^A-Z0-9]+', '_', area.upper()).strip('_') or 'PRINT'


def supplier_code(raw: str | None) -> str:
    key = (raw or '').upper()
    return SUPPLIER_NAMES.get(key, norm(raw) if raw else 'UNKNOWN')


def product_code(*texts: str | None) -> str | None:
    for t in texts:
        m = CODE_RE.search(t or '')
        if m:
            return m.group(1).upper()
    return None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


class Run:
    def __init__(self, root: Path, apply: bool):
        self.root, self.apply = root, apply
        self.lines: list[str] = []
        self.copied = self.skipped = self.failed = 0
        self.bytes = 0

    def say(self, msg: str) -> None:
        print(msg, flush=True)
        self.lines.append(msg)

    def mkdir(self, p: Path) -> None:
        if self.apply:
            p.mkdir(parents=True, exist_ok=True)

    def copy(self, src: Path, dest: Path) -> bool:
        try:
            size = src.stat().st_size
        except OSError as e:
            self.failed += 1
            self.say(f'  ! {src}: {e}')
            return False
        if dest.exists() and dest.stat().st_size == size:
            self.skipped += 1
            return True
        self.bytes += size
        self.copied += 1
        if self.apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + '.part')
            shutil.copyfile(src, tmp)
            tmp.replace(dest)
        return True

    def write_json(self, dest: Path, data) -> None:
        if self.apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')


def step_skeleton(r: Run) -> None:
    r.say('## skeleton')
    for d in ('_staging', '_fonts', '_reports', 'suppliers', 'products'):
        r.mkdir(r.root / d)
    if r.apply:
        (r.root / 'README.md').write_text(README, encoding='utf-8')
    r.say(f'  {r.root}: _staging, _fonts, _reports, suppliers, products, README.md')


def font_names(path: Path) -> tuple[str, str, str] | None:
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(str(path), lazy=True, fontNumber=0)
        name = f['name']
        get = lambda *ids: next((str(name.getDebugName(i)) for i in ids if name.getDebugName(i)), '')
        return get(16, 1), get(17, 2) or 'Regular', get(6)
    except Exception:
        return None


def step_fonts(r: Run) -> None:
    r.say('## fonts')
    seen: dict[str, dict] = {}
    for base in FONT_SOURCES:
        if not base.exists():
            continue
        for p in base.rglob('*'):
            if p.suffix.lower() not in ('.otf', '.ttf') or not p.is_file():
                continue
            digest = sha256(p)
            if digest in seen:
                seen[digest]['sources'].append(str(p))
                continue
            names = font_names(p)
            if not names:
                r.say(f'  ? unreadable font {p}')
                continue
            family, style, ps = names
            seen[digest] = {'family': family, 'style': style, 'postscript': ps, 'sha256': digest, 'ext': p.suffix.lower(), 'src': p, 'sources': [str(p)]}
    index = []
    taken: dict[str, str] = {}
    for f in sorted(seen.values(), key=lambda x: (x['family'].lower(), x['style'].lower())):
        fam_dir = re.sub(r'[^A-Za-z0-9 ._-]+', '', f['family']).strip() or 'Unknown'
        stem = re.sub(r'[^A-Za-z0-9._-]+', '', f['postscript'] or f'{f["family"]}-{f["style"]}') or 'font'
        rel = f'{fam_dir}/{stem}{f["ext"]}'
        if rel in taken and taken[rel] != f['sha256']:
            rel = f'{fam_dir}/{stem}-{f["sha256"][:8]}{f["ext"]}'
        taken[rel] = f['sha256']
        r.copy(f['src'], r.root / '_fonts' / Path(rel))
        index.append({'family': f['family'], 'style': f['style'], 'postscript': f['postscript'], 'file': rel, 'sha256': f['sha256'],
                      'sources': f['sources'][:5], 'license': None})
    r.write_json(r.root / '_fonts' / 'fonts.json', index)
    families = len({i['family'] for i in index})
    r.say(f'  {len(index)} font file(s), {families} family(ies) -> _fonts\\ (fonts.json)')


def step_suppliers(r: Run) -> None:
    r.say('## suppliers')
    cfg = json.loads((HERE / 'supplier_sources.json').read_text(encoding='utf-8'))
    base = Path(cfg['base'])
    blanks: dict[tuple[str, str], list] = {}
    for row in cfg['files']:
        src = base / row['src']
        sub = 'mockup' if row['kind'] == 'mockup' else 'template'
        dest_dir = r.root / 'suppliers' / row['supplier'] / row['blank'] / sub
        items = sorted(src.glob(row['glob'])) if row.get('glob') else [src]
        for s in items:
            if not s.exists():
                r.say(f'  ! missing {s}')
                continue
            name = s.name if row.get('glob') else row['name']
            if row.get('glob'):
                name = f'{row["blank"]}_{s.stem}_mockup{s.suffix}'
            r.copy(s, dest_dir / name)
            blanks.setdefault((row['supplier'], row['blank']), []).append({'kind': row['kind'], 'file': f'{sub}/{name}', 'note': row.get('note'), 'from': str(s)})
    for (sup, blank), files in blanks.items():
        r.write_json(r.root / 'suppliers' / sup / blank / 'blank.json', {'supplier': sup, 'blank': blank, 'files': files, 'rules': [], 'status': 'UNCHECKED'})
        r.say(f'  {sup}\\{blank}: {len(files)} file(s)')


def step_psds(r: Run) -> None:
    r.say('## psds (\\\\TMTEAM\\TEMPLATE\\2026\\MERCHIZE)')
    if not PSD_SOURCE.exists():
        r.say(f'  ! {PSD_SOURCE} not reachable')
        return
    for p in sorted(PSD_SOURCE.rglob('*')):
        if p.suffix.lower() not in ('.psd', '.psb') or not p.is_file():
            continue
        code = product_code(p.stem) or product_code(p.parent.name)
        if not code:
            r.say(f'  ? no product code in {p.name} (skipped)')
            continue
        rest = CODE_RE.sub('', p.stem, count=1)
        v1 = norm(rest) if norm(rest) != 'ALL' else 'ALL'
        date = dt.datetime.fromtimestamp(p.stat().st_mtime).strftime('%Y%m%d')
        folder = r.root / 'products' / code / 'artwork' / f'{code}-{v1}-ALL-UNKNOWN-{date}'
        r.copy(p, folder / 'master.psd')
        r.write_json(folder / 'asset.json', {
            'status': 'UNCHECKED', 'kind': 'CUSTOM_PSD', 'productCode': code, 'variant': [v1, 'ALL'], 'supplier': 'UNKNOWN',
            'source': str(p), 'size': p.stat().st_size, 'note': 'PSD thiết kế từ NAS 2026\\MERCHIZE — xưởng, variant và layer custom chưa kiểm tra',
            'importedAt': dt.datetime.now().isoformat(timespec='seconds')})
        r.say(f'  {p.name} ({p.stat().st_size // 1048576} MB) -> {code}\\artwork\\{folder.name}')


def drive_download(file_id: str, dest: Path, size: int | None) -> None:
    url = f'https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t'
    tmp = dest.with_name(dest.name + '.part')
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as res, open(tmp, 'wb') as fh:
        shutil.copyfileobj(res, fh, 1 << 20)
    got = tmp.stat().st_size
    if size and got != size:
        tmp.unlink(missing_ok=True)
        raise OSError(f'size {got} != {size} (file not shared or changed)')
    tmp.replace(dest)


def step_flat(r: Run, flat_json: Path | None) -> None:
    r.say('## flat (no-custom print sets approved on prod)')
    if not flat_json or not flat_json.exists():
        r.say('  ! --flat-json missing (export from prod first)')
        return
    sets = json.loads(flat_json.read_text(encoding='utf-8'))
    for s in sets:
        code = product_code(s['sku'], s.get('productTitle')) or norm(s['sku'].split('-')[0])
        values = [norm(v) for v in (s.get('variantOptions') or {}).values()]
        v1 = values[0] if values else 'ALL'
        v2 = '_'.join(values[1:]) if len(values) > 1 else 'ALL'
        sup = supplier_code(s.get('supplier'))
        date = (s.get('approvedAt') or '')[:10].replace('-', '') or 'NODATE'
        folder = r.root / 'products' / code / 'artwork' / f'{code}-{v1}-{v2}-{sup}-{date}'
        files = []
        for f in s['files']:
            ext = Path(f['fileName']).suffix.lower() or '.png'
            area = LINE_PREFIX_RE.sub('', f['area']).strip() or 'Print'
            dest = folder / 'print' / f'{area_name(area)}{ext}'
            if dest.exists() and f.get('size') and dest.stat().st_size == f['size']:
                r.skipped += 1
            else:
                r.copied += 1
                r.bytes += f.get('size') or 0
                if r.apply:
                    try:
                        drive_download(f['driveFileId'], dest, f.get('size'))
                    except Exception as e:  # noqa: BLE001 - one missing file must not stop the batch
                        r.failed += 1
                        r.say(f'  ! {s["taskKey"]} {f["area"]}: {e}')
                        continue
            files.append({'area': area, 'areaOnOrder': f['area'], 'file': f'print/{dest.name}', 'widthPx': f.get('widthPx'), 'heightPx': f.get('heightPx'),
                          'driveFileId': f['driveFileId'], 'size': f.get('size')})
        r.write_json(folder / 'asset.json', {
            'status': 'UNCHECKED', 'kind': 'FLAT_PRINT', 'productCode': code, 'sku': s['sku'], 'variantOptions': s.get('variantOptions'),
            'variant': [v1, v2], 'supplier': sup, 'supplierSku': s.get('supplierSku'), 'sourceOrder': s['taskKey'],
            'approvedOnOrderAt': s.get('approvedAt'), 'files': files, 'productTitle': s.get('productTitle'),
            'note': 'File in không custom đã duyệt trên đơn (Design Studio DONE) — chưa qua kiểm tra thư viện',
            'importedAt': dt.datetime.now().isoformat(timespec='seconds')})
    r.say(f'  {len(sets)} set(s)')


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=ROOT_DEFAULT)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--only', default='skeleton,fonts,suppliers,psds,flat')
    ap.add_argument('--flat-json', type=Path)
    a = ap.parse_args(argv)
    r = Run(Path(a.root), a.apply)
    steps = [s.strip() for s in a.only.split(',') if s.strip()]
    r.say(f'# Design library phase 1 — {"APPLY" if a.apply else "DRY RUN"} — {dt.datetime.now():%Y-%m-%d %H:%M} — {r.root}')
    for s in steps:
        if s == 'skeleton':
            step_skeleton(r)
        elif s == 'fonts':
            step_fonts(r)
        elif s == 'suppliers':
            step_suppliers(r)
        elif s == 'psds':
            step_psds(r)
        elif s == 'flat':
            step_flat(r, a.flat_json)
        else:
            r.say(f'unknown step {s}')
            return 2
    r.say(f'\n{"copied" if a.apply else "to copy"}: {r.copied} file(s), {r.bytes / 1e9:.2f} GB; already there: {r.skipped}; failed: {r.failed}')
    if a.apply:
        rep = r.root / '_reports' / f'phase1-{dt.datetime.now():%Y%m%d-%H%M}.md'
        rep.parent.mkdir(parents=True, exist_ok=True)
        rep.write_text('\n'.join(r.lines) + '\n', encoding='utf-8')
        print(f'report: {rep}')
    return 0 if r.failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
