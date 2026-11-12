"""Where a custom name may sit, and whether it stays there.

Geometry (rects in file pixels, x1/y1 exclusive), the lone-"No" rule, the ink of a name (pixel difference for worker
renders, the renderer's own text for flat-text) and the three guards: NO (a lone No carries no name), BOX (the ink stays
in the box the design gives it) and SAFE (box and ink stay inside the print area inset by the safe margin).
Knows nothing about the order scripts; auto_render.py feeds it paths and numbers.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

Rect = tuple[float, float, float, float]

TOLERANCE_PX = 3
INK_DIFF_THRESHOLD = 64
BAND_ROWS = 2048


@dataclass(frozen=True)
class NameBox:
    area: str
    field: str
    rect: Rect
    check_x: bool = True
    check_y: bool = True


@dataclass
class GuardResult:
    verdict: str
    guard: str | None
    reason: str
    details: dict = field(default_factory=dict)


def overflow(inner: Rect, outer: Rect, x: bool = True, y: bool = True) -> float:
    parts = []
    if x:
        parts += [outer[0] - inner[0], inner[2] - outer[2]]
    if y:
        parts += [outer[1] - inner[1], inner[3] - outer[3]]
    return float(max(parts)) if parts else 0.0


def inset_rect(rect: Rect, px: float) -> Rect:
    return (rect[0] + px, rect[1] + px, rect[2] - px, rect[3] - px)


def safe_inset_px(safe_in: float | None, dpi: float | None, min_clearance_px: float | None) -> float | None:
    vals = []
    if safe_in is not None and dpi:
        vals.append(round(float(safe_in) * float(dpi), 6))
    if min_clearance_px is not None:
        vals.append(float(min_clearance_px))
    return max(vals) if vals else None


def _rotate_point(x: float, y: float, rotation: float, pivot: tuple[float, float]) -> tuple[float, float]:
    t = math.radians(rotation)
    c, s = math.cos(t), math.sin(t)
    dx, dy = x - pivot[0], y - pivot[1]
    return pivot[0] + c * dx - s * dy, pivot[1] + s * dx + c * dy


def rotated_bounds(box: dict, rotation: float, pivot: dict | None) -> Rect:
    x0, y0 = float(box['x']), float(box['y'])
    x1, y1 = x0 + float(box['w']), y0 + float(box['h'])
    rot = float(rotation or 0)
    if abs(rot) <= 1e-6:
        return (x0, y0, x1, y1)
    pv = (float(pivot['x']), float(pivot['y'])) if pivot else ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    pts = [_rotate_point(px, py, rot, pv) for px, py in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _norm_key(key: str) -> str:
    return str(key).lower().strip().strip('_').strip().rstrip(':?').strip()


def lone_no(pairs: list[tuple[str, str]], fields: tuple[str, ...] = ()) -> bool:
    names = {'custom name', 'custom name/text'} | {_norm_key(f) for f in fields if f}
    answers = [str(v or '').strip().lower() for k, v in pairs
               if 'yes or no' in str(k).lower() or _norm_key(k) in names]
    return 'no' in answers and 'yes' not in answers


def _px(n: float) -> int:
    return int(math.ceil(round(float(n), 6)))


def judge(boxes: list[NameBox], inks: list[Rect | None], area: Rect, inset_px: float | None,
          tol: float = TOLERANCE_PX, box_overflow: float | None = None) -> GuardResult:
    paired = list(zip(boxes, inks)) if len(boxes) == len(inks) else []
    details = {'boxes': [list(b.rect) for b in boxes], 'inks': [list(i) if i else None for i in inks],
               'overflowPx': 0.0, 'insetPx': inset_px}
    worst, worst_box = None, boxes[0] if boxes else None
    for b, ink in paired:
        if ink is None:
            continue
        o = overflow(ink, b.rect, b.check_x, b.check_y)
        if worst is None or o > worst:
            worst, worst_box = o, b
    if box_overflow is not None and (worst is None or box_overflow > worst):
        worst = float(box_overflow)
    details['overflowPx'] = max(0.0, worst or 0.0)
    label = lambda b: f'{b.area} · {b.field}' if b else ''
    if worst is not None and worst > tol:
        return GuardResult('HOLD', 'BOX', f'tên vượt khung {_px(worst)} px ({label(worst_box)})', details)
    if inset_px is not None:
        safe = inset_rect(area, inset_px)
        worst_s, worst_sb = None, None
        for b in boxes:
            o = overflow(b.rect, safe)
            if worst_s is None or o > worst_s:
                worst_s, worst_sb = o, b
        for i, ink in enumerate(inks):
            if ink is None:
                continue
            o = overflow(ink, safe)
            if worst_s is None or o > worst_s:
                worst_s = o
                worst_sb = paired[i][0] if paired else (boxes[0] if boxes else None)
        if worst_s is not None and worst_s > 0:
            details['safeOverflowPx'] = worst_s
            return GuardResult('HOLD', 'SAFE', f'tên chạm safe zone: lấn {_px(worst_s)} px vào mép an toàn '
                                              f'{_px(inset_px)} px ({label(worst_sb)})', details)
        return GuardResult('PASS', None, '', details)
    return GuardResult('UNCHECKED', None, 'không kiểm được safe zone (không có template)', details)


def diff_mask(render: Image.Image, base: Image.Image, threshold: int = INK_DIFF_THRESHOLD) -> np.ndarray:
    render = render if render.mode == 'RGBA' else render.convert('RGBA')
    if base.size != render.size:
        base = base.convert('RGBA').resize(render.size, Image.LANCZOS)
    elif base.mode != 'RGBA':
        base = base.convert('RGBA')
    w, h = render.size
    mask = np.zeros((h, w), bool)
    for top in range(0, h, BAND_ROWS):
        box = (0, top, w, min(h, top + BAND_ROWS))
        a = np.asarray(render.crop(box), dtype=np.int16)
        b = np.asarray(base.crop(box), dtype=np.int16)
        mask[top:box[3]] = (np.abs(a - b) >= threshold).any(axis=2)
    return mask


def mask_bbox(mask) -> Rect | None:
    rows = np.flatnonzero(mask.any(axis=1))
    if not rows.size:
        return None
    cols = np.flatnonzero(mask.any(axis=0))
    return (float(cols[0]), float(rows[0]), float(cols[-1] + 1), float(rows[-1] + 1))


def outside_boxes(mask, rects: list[Rect], tol: float) -> float:
    """Largest Chebyshev distance (px) of an ink pixel from its nearest rect; a pixel [x, x+1) counts as inside when it lies in the rect."""
    rest = mask.copy()
    h, w = rest.shape
    for x0, y0, x1, y1 in rects:
        rest[max(0, math.floor(y0)):min(h, math.ceil(y1)), max(0, math.floor(x0)):min(w, math.ceil(x1))] = False
    ys, xs = np.nonzero(rest)
    if not xs.size or not rects:
        return 0.0
    xs = xs.astype(np.float64); ys = ys.astype(np.float64)
    best = None
    for x0, y0, x1, y1 in rects:
        dx = np.maximum(np.maximum(x0 - xs, xs + 1 - x1), 0)
        dy = np.maximum(np.maximum(y0 - ys, ys + 1 - y1), 0)
        d = np.maximum(dx, dy)
        best = d if best is None else np.minimum(best, d)
    far = float(best.max())
    return far if far > tol else 0.0


def _piece_name(fields: list[dict], file_name: str) -> str:
    for f in fields or []:
        if f.get('area'):
            return str(f['area'])
    stem = Path(file_name).name
    m = re.match(r'^[^_]+_\d+_(.+?)_auto', stem)
    if m:
        return m.group(1)
    return stem.split('_auto')[0] or 'Print'


def _open(path) -> Image.Image:
    im = Image.open(path)
    im.load()
    return im


def check_worker_piece(render_path: Path, base_path: Path | None, fields: list[dict], file_name: str,
                       no_name_expected: bool, area: Rect, inset_px: float | None,
                       photoshop_rule: dict | None = None, tol: float = TOLERANCE_PX) -> GuardResult:
    name = _piece_name(fields, file_name)
    noname_file = '-noname.' in file_name
    base_ok = base_path is not None and Path(base_path).exists()
    if no_name_expected:
        if not noname_file:
            return GuardResult('HOLD', 'NO', 'khách chọn No nhưng file in có tên', {'file': file_name})
        if base_ok and mask_bbox(diff_mask(_open(render_path), _open(base_path))) is not None:
            return GuardResult('HOLD', 'NO', 'khách chọn No nhưng file in có tên', {'file': file_name, 'inkSource': 'pixel-diff'})
        return GuardResult('PASS', None, '', {'file': file_name})
    if noname_file or not fields:
        return GuardResult('PASS', None, '', {'file': file_name})
    if photoshop_rule is not None:
        targets = photoshop_rule.get('targets') or []
        if not targets:
            return GuardResult('UNCHECKED', None, 'không kiểm được safe zone (quy tắc Photoshop không có khung)', {'inkSource': 'renderer'})
        mw, mh = float(photoshop_rule.get('maxW') or 0), float(photoshop_rule.get('maxH') or 0)
        field_name = photoshop_rule.get('field') or (fields[0].get('field') if fields else '') or ''
        boxes = [NameBox(name, field_name, (float(t['cx']) - mw / 2, float(t['cy']) - mh / 2, float(t['cx']) + mw / 2, float(t['cy']) + mh / 2))
                 for t in targets]
        r = judge(boxes, [None] * len(boxes), area, inset_px, tol)
        r.details['inkSource'] = 'renderer'
        return r
    if not base_ok:
        return GuardResult('UNCHECKED', None, 'không kiểm được safe zone (thiếu artwork gốc để so)', {'inkSource': None})
    mask = diff_mask(_open(render_path), _open(base_path))
    ink = mask_bbox(mask)
    if ink is None:
        return GuardResult('HOLD', 'BOX', f'file dựng không thấy tên ({name})', {'inkSource': 'pixel-diff'})
    boxes = [NameBox(name, str(f.get('field') or ''), rotated_bounds(f['box'], f.get('rotation') or 0, f.get('pivot'))) for f in fields]
    rects = [b.rect for b in boxes]
    inks = [ink] if len(boxes) == 1 else [None] * len(boxes)
    r = judge(boxes, inks, area, inset_px, tol, box_overflow=outside_boxes(mask, rects, 0))
    if len(boxes) != 1 and r.verdict in ('PASS', 'UNCHECKED') and inset_px is not None:
        o = overflow(ink, inset_rect(area, inset_px))
        if o > 0:
            r = GuardResult('HOLD', 'SAFE', f'tên chạm safe zone: lấn {_px(o)} px vào mép an toàn {_px(inset_px)} px '
                                            f'({name} · {boxes[0].field})', r.details)
    r.details['inkSource'] = 'pixel-diff'
    r.details['ink'] = list(ink)
    return r


# ---------------------------------------------------------------- flat-text (artwork-builder/g5/tools/name_render.py)

SOLID_ALPHA = 128
_NAME_RENDER: dict[str, object] = {}


def load_name_render(tools_dir: Path):
    tools_dir = Path(tools_dir).resolve()
    key = str(tools_dir).lower()
    if key in _NAME_RENDER:
        return _NAME_RENDER[key]
    sys.dont_write_bytecode = True
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    name = 'name_render_' + hashlib.sha1(key.encode()).hexdigest()[:10]
    spec = importlib.util.spec_from_file_location(name, tools_dir / 'name_render.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _NAME_RENDER[key] = mod
    return mod


def _text_box(t: dict) -> NameBox:
    check_x = check_y = True
    if t.get('circle'):
        check_x = check_y = False
    elif t.get('fit') == 'size':
        if t.get('rotate', 0) in (90, -90):
            check_x = False
        else:
            check_y = False
    return NameBox(t['area'], t['field'], tuple(float(v) for v in t['box']), check_x, check_y)


def flat_boxes_and_inks(nr, spec: dict, spec_dir: Path, values: dict[str, str]) -> list[tuple[NameBox, Rect | None]]:
    spec_dir = Path(spec_dir)
    areas = {a['printArea']: a for a in spec.get('areas', [])}
    sizes: dict[str, tuple[int, int]] = {}
    out = []
    for t in spec.get('texts', []):
        value = str(values.get(t['field'], t.get('fallback', '')) or '').strip()
        if not value:
            continue
        if t.get('upper'):
            value = value.upper()
        area = areas[t['area']]
        if t['area'] not in sizes:
            with Image.open(spec_dir / area['base']) as im:
                sizes[t['area']] = im.size
        full = nr.render_text(t, value, spec_dir)
        core = nr.render_text({k: v for k, v in t.items() if k != 'glow'}, value, spec_dir) if t.get('glow') else full
        solid = core.getchannel('A').point(lambda a: 255 if a >= SOLID_ALPHA else 0)
        marker = Image.new('RGBA', full.size, (0, 0, 0, 0))
        marker.paste(Image.merge('RGBA', (solid,) * 4), ((full.width - core.width) // 2, (full.height - core.height) // 2))
        sheet = Image.new('RGBA', sizes[t['area']], (0, 0, 0, 0))
        nr.place(sheet, t, marker)
        bbox = sheet.getchannel('A').getbbox()
        out.append((_text_box(t), tuple(float(v) for v in bbox) if bbox else None))
    return out


def min_clearance(spec: dict, area: str) -> float | None:
    best = None

    def walk(o):
        nonlocal best
        if isinstance(o, dict):
            if o.get('area') == area and isinstance(o.get('minimumCutClearancePx'), (int, float)):
                v = float(o['minimumCutClearancePx'])
                best = v if best is None else max(best, v)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(spec)
    return best


def no_name_render(python: str, tools_dir: Path, spec_path: Path, out_dir: Path, key: str) -> dict[str, Path]:
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8'}
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    r = subprocess.run([python, str(Path(tools_dir) / 'name_render.py'), str(spec_path), str(out_dir), key, '_=_'],
                       capture_output=True, env=env)
    stderr = r.stderr.decode('utf-8', 'replace')
    if r.returncode:
        raise RuntimeError(stderr.strip()[-200:])
    files = {}
    for line in r.stdout.decode('utf-8', 'replace').splitlines():
        if line.startswith('saved '):
            p = Path(line[6:].strip())
            stem = p.stem
            area = stem.split(f'{key} - ', 1)[1] if f'{key} - ' in stem else stem
            files[area] = p
    return files


def images_equal(a: Path, b: Path) -> bool:
    with Image.open(a) as ia, Image.open(b) as ib:
        if ia.size != ib.size:
            return False
        return mask_bbox(diff_mask(ia.convert('RGB').convert('RGBA'), ib.convert('RGB').convert('RGBA'))) is None


def _first(results: list[GuardResult]) -> GuardResult:
    for verdict in ('HOLD', 'ERROR', 'UNCHECKED'):
        for r in results:
            if r.verdict == verdict:
                return r
    return results[0] if results else GuardResult('PASS', None, '', {})


def _hold_rank(results: list[GuardResult]) -> GuardResult:
    holds = [r for r in results if r.verdict == 'HOLD']
    for g in ('NO', 'BOX', 'SAFE'):
        for r in holds:
            if r.guard == g:
                return r
    return _first(results)


def check_flat_line(key: str, spec_path: Path, values: dict[str, str], said_no: bool, files: list[dict], files_root: Path,
                    safe_in: float | None, tools_dir: Path, python: str, tmp_dir: Path, tol: float = TOLERANCE_PX) -> GuardResult:
    try:
        spec_path = Path(spec_path)
        spec = json.loads(spec_path.read_text(encoding='utf-8-sig'))
        prints = [f for f in files if (f.get('kind') or 'PRINT') != 'MOCKUP']
        if said_no and values:
            return GuardResult('HOLD', 'NO', 'khách chọn No nhưng file in có tên', {'values': dict(values)})
        if spec.get('photoshop'):
            return GuardResult('UNCHECKED', None, 'không kiểm được safe zone (spec Photoshop)', {})
        if not values:
            if prints and all(f.get('driveFileId') for f in prints):
                return GuardResult('PASS', None, '', {'files': 'drive'})
            if not said_no:
                return GuardResult('PASS', None, '', {})
            text_areas = {t['area'] for t in spec.get('texts', [])}
            local = [f for f in prints if f.get('path') and f.get('printArea') in text_areas]
            if not local:
                return GuardResult('PASS', None, '', {})
            fresh = no_name_render(python, tools_dir, spec_path, Path(tmp_dir), key)
            for f in local:
                ref = fresh.get(f['printArea'])
                pushed = Path(files_root) / f['path']
                if ref is None:
                    continue
                with Image.open(pushed) as a, Image.open(ref) as b:
                    if a.size != b.size:
                        return GuardResult('ERROR', None, 'spec flat-text không khớp khổ file', {'area': f['printArea']})
                if not images_equal(pushed, ref):
                    return GuardResult('HOLD', 'NO', 'khách chọn No nhưng file in có tên', {'area': f['printArea']})
            return GuardResult('PASS', None, '', {})
        nr = load_name_render(tools_dir)
        pairs = flat_boxes_and_inks(nr, spec, spec_path.parent, values)
        by_area: dict[str, list[tuple[NameBox, Rect | None]]] = {}
        for b, ink in pairs:
            by_area.setdefault(b.area, []).append((b, ink))
        sizes = {f['printArea']: (f.get('widthPx'), f.get('heightPx')) for f in prints}
        results = []
        for area, items in by_area.items():
            w, h = sizes.get(area, (None, None))
            if not w or not h:
                base = next(a['base'] for a in spec['areas'] if a['printArea'] == area)
                with Image.open(spec_path.parent / base) as im:
                    w, h = im.size
            inset = safe_inset_px(safe_in, spec.get('dpi', 150), min_clearance(spec, area))
            results.append(judge([b for b, _ in items], [i for _, i in items], (0, 0, float(w), float(h)), inset, tol))
        return _hold_rank(results)
    except (Exception, SystemExit) as e:
        return GuardResult('ERROR', None, f'không đo được khung tên: {type(e).__name__}: {e}', {})
