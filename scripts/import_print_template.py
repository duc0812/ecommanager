"""Import a supplier print template prepared outside the UI.

Copies the original template file to <storage>/templates/<id>/source.<ext>,
writes <storage>/templates/<id>/guide.png, upserts the PrintTemplate row
(keyed by supplier + name) and links the given supplier SKUs to it.

Example:
  python scripts/import_print_template.py --db dev.db --storage ./storage \
    --supplier-code pgprints --skus UT2-20OZ --name "20oz Stainless Steel Tumbler (US)" \
    --source "D:/TEMPLATE POD/PGprints/Tumbler20oz/Template 20oz Stainless Steel Tumbler.tif" \
    --width 3270 --height 1860 --dpi 300 --safe-in 0.19 --bleed-in 0 \
    --transparent-color 104,186,244 --tolerance 25 --clear-rect 57,56,3155,1748 --opacity 0.45
"""
import argparse
import json
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops

Image.MAX_IMAGE_PIXELS = None

SOURCE_EXTS = {'png': 'png', 'jpg': 'jpg', 'jpeg': 'jpg', 'tif': 'tif', 'tiff': 'tif', 'psd': 'psd', 'pdf': 'pdf'}


def ints(text, n, label):
    parts = [p.strip() for p in text.split(',')]
    if len(parts) != n or not all(re.fullmatch(r'-?\d+', p) for p in parts):
        raise SystemExit(f'{label} must be {n} comma-separated integers, got {text!r}')
    return [int(p) for p in parts]


def now_iso():
    now = datetime.now(timezone.utc)
    return now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}+00:00'


def safe_name(name):
    cleaned = re.sub(r'[^A-Za-z0-9._-]+', '_', name).strip('_')
    return re.sub(r'_+\.', '.', cleaned) or 'file'


def build_guide(source, width, height, opacity, colors, tolerance, rects):
    img = Image.open(source)
    img.seek(0)
    rgba = img.convert('RGBA')
    if rgba.size != (width, height):
        rgba = rgba.resize((width, height), Image.LANCZOS)
    alpha_on = max(0, min(255, round(opacity * 255)))
    r, g, b, a = rgba.split()
    alpha = a.point(lambda v: v * alpha_on // 255)
    cleared_color = 0
    if colors:
        mask = Image.new('L', (width, height), 0)
        for cr, cg, cb in colors:
            near = [band.point(lambda v, c=c: 255 if abs(v - c) <= tolerance else 0) for band, c in ((r, cr), (g, cg), (b, cb))]
            mask = ImageChops.lighter(mask, ImageChops.multiply(ImageChops.multiply(near[0], near[1]), near[2]))
        cleared_color = mask.histogram()[255]
        alpha.paste(0, mask=mask)
    cleared_rect = 0
    for rx, ry, rw, rh in rects:
        x0, y0 = max(0, rx), max(0, ry)
        x1, y1 = min(width, rx + rw), min(height, ry + rh)
        if x1 > x0 and y1 > y0:
            alpha.paste(0, (x0, y0, x1, y1))
            cleared_rect += (x1 - x0) * (y1 - y0)
    rgba.putalpha(alpha)
    return rgba, cleared_color, cleared_rect


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', required=True)
    ap.add_argument('--storage', required=True)
    ap.add_argument('--supplier-code', required=True)
    ap.add_argument('--skus', required=True, help='comma-separated supplier SKUs to link')
    ap.add_argument('--name', required=True)
    ap.add_argument('--source', required=True, help='original template file (png/jpg/tif/psd/pdf)')
    ap.add_argument('--width', type=int, required=True)
    ap.add_argument('--height', type=int, required=True)
    ap.add_argument('--dpi', type=int, default=300)
    ap.add_argument('--safe-in', type=float, default=0.2)
    ap.add_argument('--bleed-in', type=float, default=0.125)
    ap.add_argument('--mirror', action='store_true')
    ap.add_argument('--areas', help='JSON array of {name,x,y,w,h}; default one area "Print" covering the canvas')
    ap.add_argument('--guide', help='ready-made guide PNG/JPG; built from --source when omitted')
    ap.add_argument('--opacity', type=float, default=0.35, help='opacity of the built guide overlay (0-1)')
    ap.add_argument('--transparent-color', action='append', default=[], help='R,G,B made fully transparent (repeatable)')
    ap.add_argument('--tolerance', type=int, default=25)
    ap.add_argument('--clear-rect', action='append', default=[], help='x,y,w,h in output pixels made fully transparent (repeatable)')
    args = ap.parse_args()

    if args.width <= 0 or args.height <= 0 or args.dpi <= 0:
        raise SystemExit('width, height and dpi must be > 0')
    if args.safe_in < 0 or args.bleed_in < 0:
        raise SystemExit('safe-in and bleed-in must be >= 0')
    if not 0 <= args.opacity <= 1:
        raise SystemExit('opacity must be between 0 and 1')
    source = Path(args.source)
    if not source.is_file():
        raise SystemExit(f'source not found: {source}')
    src_ext = SOURCE_EXTS.get(source.suffix.lower().lstrip('.'))
    if not src_ext:
        raise SystemExit(f'source must be one of {sorted(SOURCE_EXTS)}: {source.name}')
    if source.stat().st_size > 200 * 1024 * 1024:
        raise SystemExit('source is larger than 200 MB')
    colors = [ints(c, 3, '--transparent-color') for c in args.transparent_color]
    rects = [ints(r, 4, '--clear-rect') for r in args.clear_rect]

    if args.areas:
        areas = json.loads(args.areas)
        if not isinstance(areas, list) or not areas:
            raise SystemExit('--areas must be a non-empty JSON array')
        for a in areas:
            if not a.get('name') or a['w'] <= 0 or a['h'] <= 0 or a['x'] < 0 or a['y'] < 0 \
                    or a['x'] + a['w'] > args.width or a['y'] + a['h'] > args.height:
                raise SystemExit(f'area outside the canvas or invalid: {a}')
    else:
        areas = [{'name': 'Print', 'x': 0, 'y': 0, 'w': args.width, 'h': args.height}]

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    sup = db.execute('SELECT id, name, code FROM Supplier WHERE lower(code) = lower(?)', (args.supplier_code,)).fetchone()
    if not sup:
        raise SystemExit(f'supplier code not found: {args.supplier_code}')
    skus = [s.strip() for s in args.skus.split(',') if s.strip()]
    found = {r['sku']: r for r in db.execute(
        f'SELECT id, sku, productName, variant1Value, printTemplateId FROM SupplierProduct WHERE supplierId = ? AND sku IN ({",".join("?" * len(skus))})',
        (sup['id'], *skus),
    )}
    missing = [s for s in skus if s not in found]
    if missing:
        raise SystemExit(f'SKUs not found for supplier {sup["code"]}: {", ".join(missing)}')

    existing = db.execute('SELECT id FROM PrintTemplate WHERE supplierId = ? AND name = ?', (sup['id'], args.name)).fetchone()
    template_id = existing['id'] if existing else uuid.uuid4().hex
    storage = Path(args.storage).resolve()
    tdir = storage / 'templates' / template_id
    tdir.mkdir(parents=True, exist_ok=True)

    for old in tdir.glob('source.*'):
        if old.name != f'source.{src_ext}':
            old.unlink()
    source_rel = f'templates/{template_id}/source.{src_ext}'
    shutil.copyfile(source, storage / source_rel)

    for old in tdir.glob('guide.*'):
        if old.name != 'guide.png':
            old.unlink()
    guide_rel = f'templates/{template_id}/guide.png'
    if args.guide:
        guide = Image.open(args.guide).convert('RGBA')
        if guide.size != (args.width, args.height):
            guide = guide.resize((args.width, args.height), Image.LANCZOS)
        guide.save(storage / guide_rel, optimize=True)
        guide_note = f'copied from {args.guide}'
    else:
        guide, n_color, n_rect = build_guide(source, args.width, args.height, args.opacity, colors, args.tolerance, rects)
        guide.save(storage / guide_rel, optimize=True)
        guide_note = f'built from source at {round(args.opacity * 100)}% opacity; {n_color} px cleared by colour, {n_rect} px by rect'

    ts = now_iso()
    row = {
        'supplierId': sup['id'], 'name': args.name, 'widthPx': args.width, 'heightPx': args.height, 'dpi': args.dpi,
        'bleedIn': args.bleed_in, 'safeIn': args.safe_in, 'mirror': 1 if args.mirror else 0, 'areas': json.dumps(areas),
        'guideImagePath': guide_rel, 'sourceFileName': safe_name(source.name), 'sourceFilePath': source_rel, 'updatedAt': ts,
    }
    if existing:
        db.execute(f'UPDATE PrintTemplate SET {", ".join(f"{k} = ?" for k in row)} WHERE id = ?', (*row.values(), template_id))
        action = 'updated'
    else:
        row.update({'id': template_id, 'supplierSku': None, 'templateUrl': None, 'createdAt': ts})
        db.execute(f'INSERT INTO PrintTemplate ({", ".join(row)}) VALUES ({", ".join("?" * len(row))})', tuple(row.values()))
        action = 'created'
    db.execute(
        f'UPDATE SupplierProduct SET printTemplateId = ?, updatedAt = ? WHERE supplierId = ? AND sku IN ({",".join("?" * len(skus))})',
        (template_id, ts, sup['id'], *skus),
    )
    db.commit()

    print(f'Template {action}: {args.name} ({template_id})')
    print(f'  supplier: {sup["name"]} ({sup["code"]})')
    print(f'  canvas: {args.width}x{args.height} px @ {args.dpi} DPI, bleed {args.bleed_in} in, safe {args.safe_in} in, {len(areas)} area(s)')
    print(f'  source: {storage / source_rel} ({source.stat().st_size:,} bytes)')
    print(f'  guide:  {storage / guide_rel} ({guide_note})')
    for s in skus:
        r = found[s]
        prev = f' (was {r["printTemplateId"]})' if r['printTemplateId'] and r['printTemplateId'] != template_id else ''
        print(f'  linked: {s} - {r["productName"] or "?"} / {r["variant1Value"] or "-"}{prev}')
    print('Open design tasks resolve the template when loaded; no restart needed.')


if __name__ == '__main__':
    sys.exit(main())
