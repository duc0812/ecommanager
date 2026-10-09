"""Read an artwork PSD once: custom text fields, fixed texts, artwork without custom text.

parse(psd_path, template, font_lookup) -> (result_dict, artwork_img, preview_img)

* Custom layers = type layers whose name starts with '@' (field = rest of the name, with a
  Photoshop " copy" / " copy N" suffix removed). `custom_layers` overrides this with exact
  layer names (used by tests on PSDs that were not built with the convention).
* Several layers with the same field name form ONE field. The topmost visible member is the
  primary (text, font, size, colour, box, own stroke/shadow). Other visible members below it
  only contribute effects: a member with a drop shadow gives `shadow`; an effect-free member
  drawn at an offset gives a hard shadow (dx/dy = offset, blur 0, its fill colour); a member
  with a stroke gives `stroke`; an identical duplicate is ignored. Anything else -> warning.
  Hidden members are ignored (they don't print). If every member is hidden the topmost one is
  used and a warning is added.
* All geometry is returned in template px. If the PSD size differs from the template (same
  aspect within 1%) everything is scaled; above 1% aspect mismatch is a ParseError.
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable, Iterable

import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import Resource

import textrender

CHECK_SCALE = 8
READY_MAX_SCORE = 6.0
PREVIEW_MAX = 2000
COPY_SUFFIX = re.compile(r'\s+copy(\s+\d+)?$', re.IGNORECASE)
JUSTIFY = {0: 'left', 1: 'right', 2: 'center', 3: 'left', 4: 'right', 5: 'center', 6: 'left'}


class ParseError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def _hex(rgb: Iterable[float]) -> str:
    r, g, b = (max(0, min(255, int(round(v)))) for v in rgb)
    return f'#{r:02x}{g:02x}{b:02x}'


def _s(v: Any) -> str:
    """psd_tools wraps engine-data strings in String objects; str() of those is a repr."""
    v = getattr(v, 'value', v)
    if isinstance(v, bytes):
        return v.decode('utf-8', 'replace')
    return '' if v is None else str(v)


def _key(k: Any) -> str:
    if isinstance(k, bytes):
        return k.decode('latin-1').strip()
    return str(getattr(k, 'value', k)).strip()


def _desc_color(d: Any, warnings: list[str], where: str) -> str:
    """Photoshop descriptor colour (RGB 0-255, RGB float, gray %, CMYK %) -> #rrggbb."""
    vals: dict[str, float] = {}
    try:
        for k, v in dict(d).items():
            try:
                vals[_key(k)] = float(getattr(v, 'value', v))
            except (TypeError, ValueError):
                pass
    except Exception:
        pass
    if 'Rd' in vals:
        return _hex((vals['Rd'], vals.get('Grn', 0), vals.get('Bl', 0)))
    if 'redFloat' in vals:
        return _hex((vals['redFloat'] * 255, vals.get('greenFloat', 0) * 255, vals.get('blueFloat', 0) * 255))
    if 'Gry' in vals:
        g = 255 * (1 - vals['Gry'] / 100.0)
        return _hex((g, g, g))
    if 'Cyn' in vals:
        c, m, y, k = (vals.get(n, 0) / 100.0 for n in ('Cyn', 'Mgnt', 'Ylw', 'Blck'))
        warnings.append(f'{where}: CMYK colour converted approximately')
        return _hex((255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)))
    warnings.append(f'{where}: unsupported colour model, using black')
    return '#000000'


def _engine_color(c: Any, warnings: list[str], where: str) -> str | None:
    """Engine-data colour: Type 1 = ARGB floats 0-1."""
    if not c:
        return None
    vals = [float(getattr(v, 'value', v)) for v in c.get('Values', [])]
    t = c.get('Type')
    if t == 1 and len(vals) == 4:
        return _hex(v * 255 for v in vals[1:])
    if len(vals) == 5:
        c_, m, y, k = vals[1:]
        warnings.append(f'{where}: CMYK text colour converted approximately')
        return _hex((255 * (1 - c_) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)))
    if len(vals) == 2:
        return _hex((vals[1] * 255,) * 3)
    return None


def field_name(layer_name: str) -> str:
    n = layer_name.strip()
    if n.startswith('@'):
        n = n[1:].strip()
    return COPY_SUFFIX.sub('', n).strip()


def _effects(layer) -> list:
    fx = getattr(layer, 'effects', None)
    if not fx or not getattr(fx, 'enabled', True):
        return []
    return [e for e in fx if getattr(e, 'enabled', True)]


def _enum_name(v: Any) -> str:
    return str(getattr(v, 'name', v)).upper()


def _desc(e) -> dict:
    d = getattr(e, 'descriptor', None)
    return d if d is not None else {}


def _dget(d, key: str, default=None):
    for k, v in dict(d).items():
        if _key(k) == key.strip():
            return v
    return default


def _dnum(d, key: str, default: float = 0.0) -> float:
    v = _dget(d, key)
    try:
        return float(getattr(v, 'value', v))
    except (TypeError, ValueError):
        return default


def _denum(d, key: str) -> str:
    v = _dget(d, key)
    if v is None:
        return ''
    return _key(getattr(v, 'enum', v))


BLEND_MODES = {'Nrml': 'normal', 'Scrn': 'screen', 'Mltp': 'multiply', 'linearDodge': 'linearDodge',
               'Ovrl': 'overlay', 'CDdg': 'screen', 'lighterColor': 'screen', 'Lghn': 'screen',
               'linearBurn': 'multiply', 'CBrn': 'multiply', 'Drkn': 'multiply', 'darkerColor': 'multiply'}
BEVEL_TECHNIQUES = {'SfBL': 'smooth', 'PrBL': 'chiselHard', 'Slmt': 'chiselSoft'}
INTERPOLATIONS = {'Perc': 'perceptual', 'Lnr ': 'linear', 'Lnr': 'linear', 'Gcls': 'classic'}


def _blend_mode(d, key: str, warnings: list[str], where: str) -> str:
    raw = _denum(d, key)
    mode = BLEND_MODES.get(raw)
    if mode is None:
        warnings.append(f'{where}: blend mode {raw or "?"} drawn as normal')
        return 'normal'
    if raw not in ('Nrml', 'Scrn', 'Mltp', 'linearDodge', 'Ovrl'):
        warnings.append(f'{where}: blend mode {raw} approximated as {mode}')
    return mode


def _contour_points(d) -> list[list[float]] | None:
    spec = _dget(d, 'TrnS')
    if spec is None:
        return None
    pts = []
    for p in _dget(spec, 'Crv ', []) or []:
        pts.append([round(_dnum(p, 'Hrzn'), 2), round(_dnum(p, 'Vrtc'), 2)])
    if len(pts) < 2 or pts == [[0.0, 0.0], [255.0, 255.0]]:
        return None
    return pts


def read_gradient(e, warnings: list[str], where: str, canvas: tuple[float, float]) -> dict | None:
    d = _desc(e)
    gtype = _denum(d, 'Type')
    if gtype not in ('Lnr', 'Lnr '):
        warnings.append(f'{where}: gradient overlay type {gtype or "?"} is not supported (linear only)')
        return None
    grad = _dget(d, 'Grad') or {}
    if _denum(grad, 'GrdF') not in ('CstS', ''):
        warnings.append(f'{where}: noise gradient is not supported')
        return None
    intr = _dnum(grad, 'Intr', 4096.0)
    stops = []
    for c in _dget(grad, 'Clrs', []) or []:
        if _denum(c, 'Type') not in ('UsrS', ''):
            warnings.append(f'{where}: gradient stop uses foreground/background colour')
        stops.append({'pos': round(_dnum(c, 'Lctn') / 4096.0, 5), 'color': _desc_color(_dget(c, 'Clr '), warnings, where),
                      'mid': round(_dnum(c, 'Mdpn', 50) / 100.0, 4)})
    alpha = []
    for t in _dget(grad, 'Trns', []) or []:
        alpha.append({'pos': round(_dnum(t, 'Lctn') / 4096.0, 5), 'opacity': round(_dnum(t, 'Opct', 100) / 100.0, 4),
                      'mid': round(_dnum(t, 'Mdpn', 50) / 100.0, 4)})
    off = _dget(d, 'Ofst') or {}
    g = {
        'type': 'linear', 'angle': round(_dnum(d, 'Angl'), 3), 'scale': round(_dnum(d, 'Scl ', 100), 3),
        'offset': {'x': round(_dnum(off, 'Hrzn'), 4), 'y': round(_dnum(off, 'Vrtc'), 4)},
        'align': bool(_dget(d, 'Algn', True)), 'reverse': bool(_dget(d, 'Rvrs', False)),
        'opacity': round(_dnum(d, 'Opct', 100) / 100.0, 4),
        'interpolation': INTERPOLATIONS.get(_denum(d, 'gs99'), 'classic'), 'smoothness': round(intr / 4096.0, 4),
        'stops': stops,
    }
    if any(a['opacity'] < 1 for a in alpha):
        g['alphaStops'] = alpha
    if not g['align']:
        g['frame'] = {'x': 0, 'y': 0, 'w': canvas[0], 'h': canvas[1]}
    if _denum(d, 'Md  ') != 'Nrml':
        warnings.append(f'{where}: gradient overlay blend mode {_denum(d, "Md  ")} drawn as normal')
    return g


def read_bevel(e, warnings: list[str], where: str, k: float, global_light: tuple[float, float]) -> dict | None:
    d = _desc(e)
    style = _denum(d, 'bvlS')
    if style not in ('InrB', ''):
        warnings.append(f'{where}: bevel style {style} is not supported (inner bevel only)')
        return None
    if _dget(d, 'useTexture', False):
        warnings.append(f'{where}: bevel texture is not supported')
    if _dget(d, 'useShape', False):
        warnings.append(f'{where}: bevel contour (shape) is not supported')
    if _dget(d, 'uglg', False):
        angle, altitude = global_light
    else:
        angle, altitude = _dnum(d, 'lagl', 120), _dnum(d, 'Lald', 30)
    b = {
        'technique': BEVEL_TECHNIQUES.get(_denum(d, 'bvlT'), 'smooth'),
        'depth': round(_dnum(d, 'srgR', 100), 3),
        'direction': 'down' if _denum(d, 'bvlD') == 'Out' else 'up',
        'size': round(_dnum(d, 'blur') * k, 3), 'soften': round(_dnum(d, 'Sftn') * k, 3),
        'angle': round(angle, 3), 'altitude': round(altitude, 3),
        'highlight': {'color': _desc_color(_dget(d, 'hglC'), warnings, where), 'opacity': round(_dnum(d, 'hglO', 75) / 100.0, 4),
                      'mode': _blend_mode(d, 'hglM', warnings, where)},
        'shadow': {'color': _desc_color(_dget(d, 'sdwC'), warnings, where), 'opacity': round(_dnum(d, 'sdwO', 75) / 100.0, 4),
                   'mode': _blend_mode(d, 'sdwM', warnings, where)},
    }
    contour = _contour_points(d)
    if contour:
        b['contour'] = contour
    return b


# ---------------------------------------------------------------- one type layer

def read_type_layer(l, kx: float, ky: float, warnings: list[str], global_light: tuple[float, float] = (30.0, 30.0),
                    canvas: tuple[float, float] = (0.0, 0.0)) -> dict:
    """Everything we need from one type layer, already in template px."""
    where = f'layer "{l.name}"'
    k = (kx + ky) / 2.0
    ed = l.engine_dict
    rd = l.resource_dict
    font_set = [_s(f.get('Name', '')).strip('\x00') for f in rd.get('FontSet', [])]
    text = _s(ed.get('Editor', {}).get('Text', l.text or ''))

    # per-UTF16-unit style lookup -> per character
    runs = ed['StyleRun']
    lengths = list(runs['RunLengthArray'])
    sheets = [r['StyleSheet']['StyleSheetData'] for r in runs['RunArray']]
    styles_per_char = []
    ri, used = 0, 0
    for ch in text:
        units = 2 if ord(ch) > 0xFFFF else 1
        while ri < len(lengths) - 1 and used >= lengths[ri]:
            ri, used = ri + 1, 0
        styles_per_char.append(sheets[min(ri, len(sheets) - 1)] if sheets else {})
        used += units
    sample = text.replace('\r', '\n').rstrip('\n')
    visible_styles = [s for ch, s in zip(text, styles_per_char) if not ch.isspace()] or sheets[:1] or [{}]
    st = visible_styles[0]

    fonts = {font_set[s.get('Font', 0)] if s.get('Font', 0) < len(font_set) else '' for s in visible_styles}
    font = font_set[st.get('Font', 0)] if font_set else ''
    if len(fonts) > 1:
        warnings.append(f'{where}: several fonts in one layer ({", ".join(sorted(fonts))}); using {font}')
    sizes = {round(float(s.get('FontSize', 0)), 2) for s in visible_styles}
    if len(sizes) > 1:
        warnings.append(f'{where}: several font sizes in one layer; using the first')

    xx, xy, yx, yy, tx, ty = (float(v) for v in l.transform)
    hscale = math.hypot(xx, xy)
    vscale = math.hypot(yx, yy)
    rotation = math.degrees(math.atan2(xy, xx))
    if abs(rotation) > 0.5:
        warnings.append(f'{where}: text is rotated {rotation:.1f}° (not rendered rotated)')
    v_char = float(st.get('VerticalScale') or 1.0)
    h_char = float(st.get('HorizontalScale') or 1.0)
    size_px = float(st.get('FontSize', 0)) * vscale * v_char * ky
    scale_x = (hscale * h_char * kx) / (vscale * v_char * ky) if vscale and v_char else 1.0

    colors = []
    for ch, s in zip(text, styles_per_char):
        if not ch.isspace():
            colors.append(_engine_color(s.get('FillColor'), warnings, where) or '#000000')
    color = colors[0] if colors else '#000000'
    char_colors = colors if len(set(colors)) > 1 else None

    paras = ed.get('ParagraphRun', {}).get('RunArray', [])
    pprops = paras[0]['ParagraphSheet']['Properties'] if paras else {}
    align = JUSTIFY.get(int(pprops.get('Justification', 0) or 0), 'left')
    if st.get('AutoLeading', True):
        leading = float(pprops.get('AutoLeading', 1.2) or 1.2) * size_px
    else:
        leading = float(st.get('Leading', 0)) * vscale * ky
        if '\n' not in sample and leading < 0.6 * size_px:
            # never visible on a one-line sample, but would make wrapped customer text overlap
            leading = 1.2 * size_px

    for flag, label in (('FauxBold', 'faux bold'), ('FauxItalic', 'faux italic'), ('Underline', 'underline'),
                        ('Strikethrough', 'strikethrough')):
        if st.get(flag):
            warnings.append(f'{where}: {label} is not supported')
    if st.get('FontCaps'):
        warnings.append(f'{where}: all caps / small caps option is not supported')
    if float(st.get('BaselineShift') or 0):
        warnings.append(f'{where}: baseline shift is not supported')
    if st.get('StrokeFlag'):
        warnings.append(f'{where}: character stroke (not a layer style) is not supported')

    shapes = ed.get('Rendered', {}).get('Shapes', {})
    if shapes.get('WritingDirection', 0):
        warnings.append(f'{where}: vertical text is not supported')
    para_x = None
    children = shapes.get('Children') or []
    if children:
        cookie = children[0].get('Cookie', {}).get('Photoshop', {})
        bb = cookie.get('BoxBounds')
        if cookie.get('ShapeType') == 1 and bb and abs(rotation) <= 0.5:
            x0 = (tx + float(bb[0]) * xx) * kx
            x1 = (tx + float(bb[2]) * xx) * kx
            para_x = (min(x0, x1), max(x0, x1))

    warp = getattr(l, 'warp', None) or {}
    ws = None
    for kk, v in dict(warp).items():
        if _key(kk) == 'warpStyle':
            ws = getattr(v, 'enum', v)
    ws = _key(ws) if ws is not None else 'warpNone'
    if ws and ws != 'warpNone':
        warnings.append(f'{where}: warped text ({ws}) is not rendered')

    stroke = shadow = gradient = bevel = None
    for e in _effects(l):
        name = type(e).__name__
        if name == 'DropShadow':
            ang = math.radians(float(e.angle))
            dist = float(e.distance)
            shadow = {'dx': round(-math.cos(ang) * dist * kx, 2), 'dy': round(math.sin(ang) * dist * ky, 2),
                      'blur': round(float(e.size) * k, 2), 'color': _desc_color(e.color, warnings, where),
                      'opacity': round(float(e.opacity) / 100.0, 3)}
            if float(getattr(e, 'choke', 0) or 0):
                shadow['spread'] = round(float(e.choke), 2)
            if _enum_name(e.blend_mode).split('.')[-1] not in ('NORMAL', 'MULTIPLY'):
                warnings.append(f'{where}: drop shadow blend mode {_enum_name(e.blend_mode)} drawn as normal')
        elif name == 'Stroke':
            pos = _enum_name(e.position).split('.')[-1]
            if 'SOLID' not in _enum_name(e.fill_type) and 'SCLR' not in _enum_name(e.fill_type):
                warnings.append(f'{where}: gradient/pattern stroke is not supported')
                continue
            if pos.startswith('INSIDE') or pos == 'INSF':
                warnings.append(f'{where}: inside stroke is not supported')
                continue
            px = float(e.size) * k * (0.5 if pos.startswith('CENT') or pos == 'CTRF' else 1.0)
            stroke = {'px': round(px, 2), 'color': _desc_color(e.color, warnings, where)}
            if float(e.opacity) < 100:
                warnings.append(f'{where}: stroke opacity {e.opacity:.0f}% drawn as 100%')
        elif name == 'ColorOverlay' and float(e.opacity) >= 100 and _enum_name(e.blend_mode).endswith('NORMAL'):
            color = _desc_color(e.color, warnings, where)
            char_colors = None
        elif name == 'GradientOverlay':
            gradient = read_gradient(e, warnings, where, canvas)
        elif name == 'BevelEmboss':
            bevel = read_bevel(e, warnings, where, k, global_light)
        else:
            warnings.append(f'{where}: layer style {name} is not supported')

    if l.opacity < 255:
        warnings.append(f'{where}: layer opacity {round(l.opacity / 2.55)}% is not supported')
    if _enum_name(l.blend_mode).split('.')[-1] not in ('NORMAL', 'PASS_THROUGH'):
        warnings.append(f'{where}: blend mode {_enum_name(l.blend_mode)} is not supported')
    if getattr(l, 'clip_layers', None):
        warnings.append(f'{where}: layers clipped to this text are dropped (not rendered on custom text)')

    x0, y0, x1, y1 = l.bbox
    return {
        'name': l.name, 'text': sample, 'font': font, 'sizePx': size_px, 'scaleX': scale_x, 'color': color,
        'charColors': char_colors, 'align': align, 'tracking': float(st.get('Tracking') or 0),
        'leading': leading, 'stroke': stroke, 'shadow': shadow, 'gradient': gradient, 'bevel': bevel, 'paraX': para_x,
        'ink': (x0 * kx, y0 * ky, x1 * kx, y1 * ky), 'origin': (tx * kx, ty * ky),
        'visible': l.is_visible(), 'hasEffects': bool(_effects(l)), '_layer': l, '_k': (kx, ky),
    }


# ---------------------------------------------------------------- grouping

def _same_pos(a: dict, b: dict, tol: float = 2.0) -> bool:
    return all(abs(p - q) <= tol for p, q in zip(a['ink'], b['ink']))


def merge_group(members: list[dict], warnings: list[str], fname: str) -> tuple[dict, list[str]]:
    """members are bottom -> top. Returns (primary info with merged effects, member names)."""
    visible = [m for m in members if m['visible']]
    if not visible:
        warnings.append(f'field "{fname}": layer is hidden in the PSD')
        visible = [members[-1]]
    primary = dict(visible[-1])
    for m in reversed(visible[:-1]):
        if m['text'] != primary['text'] and m['shadow'] is None:
            warnings.append(f'field "{fname}": layer "{m["name"]}" has different text, ignored')
            continue
        if m['shadow'] is not None and primary['shadow'] is None:
            primary['shadow'] = dict(m['shadow'])
            if not _same_pos(m, primary):
                primary['shadow']['dx'] = round(primary['shadow']['dx'] + m['origin'][0] - primary['origin'][0], 2)
                primary['shadow']['dy'] = round(primary['shadow']['dy'] + m['origin'][1] - primary['origin'][1], 2)
            if m['stroke'] is not None and primary['stroke'] is None:
                primary['stroke'] = m['stroke']
            continue
        if m['stroke'] is not None and primary['stroke'] is None and _same_pos(m, primary):
            primary['stroke'] = m['stroke']
            continue
        if not m['hasEffects'] and not _same_pos(m, primary, 0.75) and primary['shadow'] is None:
            primary['shadow'] = {'dx': round(m['origin'][0] - primary['origin'][0], 2),
                                 'dy': round(m['origin'][1] - primary['origin'][1], 2),
                                 'blur': 0, 'color': m['color'], 'opacity': 1.0}
            continue
        if not m['hasEffects'] and _same_pos(m, primary, 0.75) and m['color'] == primary['color']:
            continue
        warnings.append(f'field "{fname}": extra layer "{m["name"]}" is not represented')
    return primary, [m['name'] for m in members]


def _overlap(a: dict, b: dict) -> bool:
    ax0, ay0, ax1, ay1 = a['ink']
    bx0, by0, bx1, by1 = b['ink']
    return min(ax1, bx1) > max(ax0, bx0) and min(ay1, by1) > max(ay0, by0)


def placements(infos: list[dict]) -> list[list[int]]:
    """Split the layers of one field into placements: layers whose ink boxes overlap (directly or through
    another member) are one placement (a text plus its effect copies); separate boxes are separate placements
    where the customer value is drawn again. Order (bottom -> top) is kept inside and across placements."""
    parent = list(range(len(infos)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(len(infos)):
        for j in range(i + 1, len(infos)):
            if _overlap(infos[i], infos[j]):
                parent[find(j)] = find(i)
    clusters: dict[int, list[int]] = {}
    for i in range(len(infos)):
        clusters.setdefault(find(i), []).append(i)
    return sorted(clusters.values(), key=lambda c: c[0])


# ---------------------------------------------------------------- geometry

def _area_for(box: dict, areas: list[dict]) -> str | None:
    cx, cy = box['x'] + box['w'] / 2.0, box['y'] + box['h'] / 2.0
    best, best_ov = None, 0.0
    for a in areas or []:
        try:
            ax, ay, aw, ah = float(a['x']), float(a['y']), float(a['w']), float(a['h'])
        except (KeyError, TypeError, ValueError):
            continue
        if ax <= cx <= ax + aw and ay <= cy <= ay + ah:
            return a.get('name')
        ov = max(0.0, min(ax + aw, box['x'] + box['w']) - max(ax, box['x'])) * \
            max(0.0, min(ay + ah, box['y'] + box['h']) - max(ay, box['y']))
        if ov > best_ov:
            best, best_ov = a.get('name'), ov
    return best


def build_field(p: dict, fname: str, layers: list[str], font_path: str | None, diag: dict,
                canvas_w: float | None = None) -> dict:
    ix0, iy0, ix1, iy1 = p['ink']
    f: dict[str, Any] = {
        'field': fname, 'layer': p['name'], 'sample': p['text'], 'font': p['font'],
        'sizePx': round(p['sizePx'], 2), 'color': p['color'], 'align': p['align'],
        'box': None, 'anchor': 'center', 'tracking': round(p['tracking'], 2),
        'leading': round(p['leading'], 2), 'fit': 'shrink',
    }
    if abs(p['scaleX'] - 1.0) > 0.005:
        f['scaleX'] = round(p['scaleX'], 4)
    if p['charColors']:
        f['charColors'] = p['charColors']
    if p['stroke']:
        f['stroke'] = p['stroke']
    if p['shadow']:
        f['shadow'] = p['shadow']
    if p.get('gradient'):
        f['gradient'] = p['gradient']
    if p.get('bevel'):
        f['bevel'] = p['bevel']
    if len(layers) > 1:
        f['layers'] = layers

    if p['paraX'] and p['paraX'][1] - p['paraX'][0] >= ix1 - ix0:
        bx0, bx1 = p['paraX']
        if canvas_w:
            # paragraph boxes often run off the canvas; keep the alignment point, clip the rest
            if f['align'] == 'center':
                cx = (bx0 + bx1) / 2.0
                half = max(min((bx1 - bx0) / 2.0, cx, canvas_w - cx), (ix1 - ix0) / 2.0, max(cx - ix0, ix1 - cx))
                bx0, bx1 = cx - half, cx + half
            else:
                bx0, bx1 = min(max(bx0, 0.0), ix0), max(min(bx1, canvas_w), ix1)
    else:
        bx0, bx1 = ix0, ix1
    f['box'] = {'x': bx0, 'y': iy0, 'w': bx1 - bx0, 'h': iy1 - iy0}
    d = {'field': fname, 'psdInkW': round(ix1 - ix0, 1), 'psdInkH': round(iy1 - iy0, 1), 'sizePx': f['sizePx']}

    if font_path:
        ref = _layer_alpha(p)
        if ref is not None:
            fitted = _fit_tracking(f, font_path, ref[0])
            if fitted is not None:
                d['trackingFit'] = {'from': f['tracking'], 'to': fitted[0], 'iouFrom': fitted[1], 'iouTo': fitted[2]}
                f['tracking'] = fitted[0]
        probe = dict(f, fit='none', box={'x': 0, 'y': 0, 'w': 10, 'h': 10})
        lay = textrender.layout(probe, f['sample'], font_path)
        adv = max(lay['widths'] or [0.0]) * lay['scaleX']
        h = lay['blockH']
        w = max(bx1 - bx0, adv + 4)
        if f['align'] == 'left':
            x = bx0
        elif f['align'] == 'right':
            x = bx1 - w
        else:
            x = (bx0 + bx1) / 2.0 - w / 2.0
        y = (iy0 + iy1) / 2.0 - h / 2.0
        probe['box'] = {'x': x, 'y': y, 'w': w, 'h': h}
        _, _, info = textrender.render_field(probe, f['sample'], font_path)
        our_alpha, our_off = info['fill']
        rb = our_alpha.getbbox()
        if rb:
            rx0, ry0, rx1, ry1 = rb[0] + our_off[0], rb[1] + our_off[1], rb[2] + our_off[0], rb[3] + our_off[1]
            if f['align'] == 'left':
                dx = ix0 - rx0
            elif f['align'] == 'right':
                dx = ix1 - rx1
            else:
                dx = (ix0 + ix1) / 2.0 - (rx0 + rx1) / 2.0
            dy = (iy0 + iy1) / 2.0 - (ry0 + ry1) / 2.0
            ref = _layer_alpha(p)
            if ref is not None:
                shift = _best_shift(ref[0], ref[1], our_alpha, (our_off[0] + dx, our_off[1] + dy),
                                    max(8, int(f['sizePx'] * 0.3)))
                if shift is not None:
                    dx, dy = dx + shift[0], dy + shift[1]
                    d['correlationShift'] = list(shift)
            x, y = x + dx, y + dy
            d.update({'renderInkW': rx1 - rx0, 'renderInkH': ry1 - ry0,
                      'inkHeightRatio': round((iy1 - iy0) / max(ry1 - ry0, 1), 4),
                      'inkWidthRatio': round((ix1 - ix0) / max(rx1 - rx0, 1), 4)})
        x0, y0 = math.floor(x), math.floor(y)
        f['box'] = {'x': x0, 'y': y0, 'w': math.ceil(x + w) - x0, 'h': math.ceil(y + h) - y0}
        # keep the sample at its true size inside the rounded box
        f['box']['h'] = max(f['box']['h'], math.ceil(h) + 1)
    else:
        f['box'] = {k: int(round(v)) for k, v in f['box'].items()}
    key, n = p['name'], 2
    while key in diag:
        key, n = f'{p["name"]} #{n}', n + 1
    diag[key] = d
    return f


TRACKING_FIT_RANGE = 60
TRACKING_FIT_MIN_GAIN = 0.01


def _sample_alpha(f: dict, font_path: str, tracking: float) -> np.ndarray:
    probe = dict(f, fit='none', tracking=tracking, box={'x': 0, 'y': 0, 'w': 10, 'h': 10})
    for k in ('stroke', 'shadow', 'gradient', 'bevel', 'charColors'):
        probe.pop(k, None)
    _, _, info = textrender.render_field(probe, f['sample'], font_path)
    a = np.asarray(info['fill'][0], dtype=np.float32) / 255.0
    ys, xs = np.nonzero(a > 0.02)
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] if len(ys) else a


def _iou_best_shift(ref: np.ndarray, ours: np.ndarray) -> float:
    from scipy.signal import fftconvolve
    pad = max(ours.shape) // 4 + 8
    R = np.pad(ref, ((pad + ours.shape[0], pad + ours.shape[0]), (pad + ours.shape[1], pad + ours.shape[1])))
    c = fftconvolve(R, ours[::-1, ::-1], mode='valid')
    y, x = np.unravel_index(int(np.argmax(c)), c.shape)
    P = np.zeros_like(R)
    P[y:y + ours.shape[0], x:x + ours.shape[1]] = ours
    return float(np.minimum(P, R).sum() / max(np.maximum(P, R).sum(), 1e-6))


def _fit_tracking(f: dict, font_path: str, ref: Image.Image) -> tuple[float, float, float] | None:
    """Photoshop and Pillow space glyphs slightly differently (hinting, fractional widths). Fit the tracking
    that makes our sample overlap the layer's own pixels best; keep the PSD value unless it gains IoU."""
    sample = f.get('sample') or ''
    if '\n' in sample or len(sample.strip()) < 2:
        return None
    r = np.asarray(ref, dtype=np.float32) / 255.0
    if r.size == 0 or r.max() <= 0:
        return None
    base = float(f.get('tracking') or 0)
    scores = {}

    def score(t: float) -> float:
        if t not in scores:
            scores[t] = _iou_best_shift(r, _sample_alpha(f, font_path, t))
        return scores[t]
    best = base
    for t in np.arange(base - TRACKING_FIT_RANGE, base + TRACKING_FIT_RANGE + 0.1, 10.0):
        if score(float(t)) > score(best):
            best = float(t)
    for t in np.arange(best - 8, best + 8.1, 2.0):
        if score(float(t)) > score(best):
            best = float(t)
    if score(best) - score(base) < TRACKING_FIT_MIN_GAIN:
        return None
    return round(best, 1), round(score(base), 4), round(score(best), 4)


def _layer_alpha(p: dict):
    """The type layer's own raster alpha (Photoshop's rendering of the sample), template px."""
    l = p.get('_layer')
    if l is None:
        return None
    try:
        im = l.topil()
    except Exception:
        return None
    if im is None:
        return None
    a = im.getchannel('A') if 'A' in im.getbands() else im.convert('L')
    kx, ky = p.get('_k', (1.0, 1.0))
    x0, y0 = l.bbox[0], l.bbox[1]
    if abs(kx - 1) > 1e-6 or abs(ky - 1) > 1e-6:
        a = a.resize((max(1, round(a.width * kx)), max(1, round(a.height * ky))), Image.LANCZOS)
    return a, (x0 * kx, y0 * ky)


def _best_shift(ref: Image.Image, ref_off, ours: Image.Image, our_off, max_shift: int):
    """Integer (dx, dy) to move `ours` onto `ref`, by FFT cross-correlation of the masks."""
    ox, oy = int(round(our_off[0])), int(round(our_off[1]))
    rx, ry = int(round(ref_off[0])), int(round(ref_off[1]))
    fx0 = min(ox, rx) - max_shift
    fy0 = min(oy, ry) - max_shift
    fx1 = max(ox + ours.width, rx + ref.width) + max_shift
    fy1 = max(oy + ours.height, ry + ref.height) + max_shift
    W, H = fx1 - fx0, fy1 - fy0
    step = max(1, int(math.ceil(math.sqrt(W * H / 4e6))))
    def frame(im, x, y, s):
        arr = np.zeros(((H + s - 1) // s, (W + s - 1) // s), dtype=np.float32)
        small = im if s == 1 else im.resize((max(1, im.width // s), max(1, im.height // s)), Image.BOX)
        a = np.asarray(small, dtype=np.float32) / 255.0
        yy, xx = (y - fy0) // s, (x - fx0) // s
        h, w = min(a.shape[0], arr.shape[0] - yy), min(a.shape[1], arr.shape[1] - xx)
        arr[yy:yy + h, xx:xx + w] = a[:h, :w]
        return arr
    R, O = frame(ref, rx, ry, step), frame(ours, ox, oy, step)
    corr = np.fft.irfft2(np.fft.rfft2(R) * np.conj(np.fft.rfft2(O)), s=R.shape)
    lim = max_shift // step + 1
    best, bd = None, (0, 0)
    for dy in range(-lim, lim + 1):
        for dx in range(-lim, lim + 1):
            v = corr[dy % R.shape[0], dx % R.shape[1]]
            if best is None or v > best:
                best, bd = v, (dx, dy)
    if not best or best <= 0:
        return None
    if step == 1:
        return bd
    Rf, Of = frame(ref, rx, ry, 1), frame(ours, ox, oy, 1)
    cx, cy = bd[0] * step, bd[1] * step
    best, out = None, (cx, cy)
    for dy in range(cy - step, cy + step + 1):
        for dx in range(cx - step, cx + step + 1):
            v = float((Rf * np.roll(np.roll(Of, dy, axis=0), dx, axis=1)).sum())
            if best is None or v > best:
                best, out = v, (dx, dy)
    return out


# ---------------------------------------------------------------- images

def _flat(im: Image.Image) -> np.ndarray:
    im = im.convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    return np.asarray(bg.convert('RGB'), dtype=np.int16)


def check_score(composed: Image.Image, reference: Image.Image, fields: list[dict]) -> float | None:
    """Mean abs diff (0-255) at 1/CHECK_SCALE over the union of field boxes (+ effect margins)."""
    if not fields:
        return None
    s = CHECK_SCALE
    W, H = composed.size
    a = _flat(composed.reduce(s))
    b = _flat(reference.reduce(s))
    mask = np.zeros(a.shape[:2], dtype=bool)
    for f in fields:
        bx = f['box']
        m = (f.get('stroke') or {}).get('px', 0) or 0
        sh = f.get('shadow') or {}
        m += max(abs(sh.get('dx', 0) or 0), abs(sh.get('dy', 0) or 0)) + (sh.get('blur', 0) or 0)
        x0 = max(0, int((bx['x'] - m) // s))
        y0 = max(0, int((bx['y'] - m) // s))
        x1 = min(a.shape[1], int(math.ceil((bx['x'] + bx['w'] + m) / s)))
        y1 = min(a.shape[0], int(math.ceil((bx['y'] + bx['h'] + m) / s)))
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = True
    if not mask.any():
        return None
    return round(float(np.abs(a - b)[mask].mean()), 3)


def _to_template(im: Image.Image, tw: int, th: int) -> Image.Image:
    im = im.convert('RGBA')
    return im if im.size == (tw, th) else im.resize((tw, th), Image.LANCZOS)


# ---------------------------------------------------------------- main entry

def parse(psd_path: str, template: dict | None = None,
          font_lookup: Callable[[str], str | None] | None = None,
          custom_layers: set[str] | dict[str, str] | None = None, debug_dir: str | None = None):
    psd = PSDImage.open(psd_path)
    W, H = psd.width, psd.height
    template = template or {}
    TW = int(template.get('widthPx') or W)
    TH = int(template.get('heightPx') or H)
    areas = template.get('areas') or []
    warnings: list[str] = []
    if (W, H) != (TW, TH):
        if abs((W / H) / (TW / TH) - 1.0) > 0.01:
            raise ParseError(f'PSD is {W}x{H} px but the template is {TW}x{TH} px (aspect ratio differs)')
        warnings.append(f'PSD is {W}x{H} px, template is {TW}x{TH} px; positions were scaled')
    if _enum_name(psd.color_mode).split('.')[-1] != 'RGB':
        warnings.append(f'PSD colour mode is {_enum_name(psd.color_mode)}, expected RGB')
    kx, ky = TW / W, TH / H

    mapping: dict[str, str] | None = None
    if isinstance(custom_layers, dict):
        mapping = {str(k): str(v).strip() for k, v in custom_layers.items() if str(v).strip()}
    elif custom_layers is not None:
        mapping = {n: field_name(n) for n in custom_layers}

    def custom_field(l) -> str | None:
        if mapping is not None and l.name in mapping:
            return mapping[l.name]
        if l.name.strip().startswith('@') and (mapping is None or not isinstance(custom_layers, (set, frozenset, list, tuple))):
            return field_name(l.name)
        return None

    try:
        global_light = (float(psd.image_resources.get_data(Resource.GLOBAL_ANGLE, 30.0)),
                        float(psd.image_resources.get_data(Resource.GLOBAL_ALTITUDE, 30.0)))
    except Exception:
        global_light = (30.0, 30.0)

    type_layers = [l for l in psd.descendants() if l.kind == 'type']
    custom = [l for l in type_layers if custom_field(l) is not None]
    custom_ids = {id(l) for l in custom}
    fixed = [{'name': l.name, 'text': _s(l.text).replace('\r', '\n').rstrip('\n'),
              'font': _first_font(l)} for l in type_layers if id(l) not in custom_ids and l.is_visible()]

    groups: dict[str, list] = {}
    for l in custom:
        groups.setdefault(custom_field(l), []).append(l)

    fields: list[dict] = []
    missing: list[str] = []
    font_paths: dict[str, str | None] = {}
    diag: dict[str, Any] = {}
    forced_visible: set[int] = set()
    for fname, layers in groups.items():
        infos = [read_type_layer(l, kx, ky, warnings, global_light, (TW, TH)) for l in layers]
        for cluster in placements(infos):
            members = [layers[i] for i in cluster]
            cinfos = [infos[i] for i in cluster]
            primary, names = merge_group(cinfos, warnings, fname)
            if not any(i['visible'] for i in cinfos):
                forced_visible.add(id(members[-1]))
            ps = primary['font']
            if ps not in font_paths:
                font_paths[ps] = font_lookup(ps) if font_lookup else None
                if font_paths[ps] is None and ps not in missing:
                    missing.append(ps)
            f = build_field(primary, fname or primary['name'], names, font_paths[ps], diag, TW)
            area = _area_for(f['box'], areas)
            if area:
                f['area'] = area
            fields.append(f)
    fields.reverse()  # top of the layer panel first
    if not custom:
        warnings.append('no custom text layers found (name them @Field Name)')

    artwork = psd.composite(layer_filter=lambda l: l.is_visible() and id(l) not in custom_ids)
    if artwork is None:
        artwork = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    if forced_visible or not psd.has_preview():
        reference = psd.composite(force=True, layer_filter=lambda l: l.is_visible() or id(l) in forced_visible)
    else:
        reference = psd.topil()
    artwork_t = _to_template(artwork, TW, TH)
    reference_t = _to_template(reference, TW, TH)

    score = None
    composed = None
    if fields and not missing:
        composed = artwork_t.copy()
        for f in fields:
            textrender.draw_field(composed, f, f['sample'], font_paths[f['font']])
        score = check_score(composed, reference_t, fields)

    warnings = list(dict.fromkeys(warnings))
    if missing:
        status = 'NEEDS_FONTS'
    elif not warnings and score is not None and score <= READY_MAX_SCORE:
        status = 'READY'
    else:
        status = 'NEEDS_REVIEW'

    preview = reference.convert('RGBA')
    preview.thumbnail((PREVIEW_MAX, PREVIEW_MAX), Image.LANCZOS)

    if debug_dir:
        import os
        os.makedirs(debug_dir, exist_ok=True)
        reference_t.save(os.path.join(debug_dir, 'reference.png'))
        if composed is not None:
            composed.save(os.path.join(debug_dir, 'check.png'))

    result = {
        'status': status,
        'psd': {'widthPx': W, 'heightPx': H},
        'template': {'widthPx': TW, 'heightPx': TH},
        'fields': fields,
        'fixedTexts': fixed,
        'missingFonts': missing,
        'warnings': warnings,
        'checkScore': score,
        'fonts': sorted({f['font'] for f in fields}),
        'diagnostics': diag,
    }
    return result, artwork_t, preview


def _first_font(l) -> str:
    try:
        fs = [_s(f.get('Name', '')).strip('\x00') for f in l.resource_dict.get('FontSet', [])]
        st = l.engine_dict['StyleRun']['RunArray'][0]['StyleSheet']['StyleSheetData']
        return fs[st.get('Font', 0)]
    except Exception:
        return ''
