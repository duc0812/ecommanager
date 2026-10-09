"""Draw one artwork field with Pillow.

Shared by the PSD check step and (next spec) order print-file renders, so it must stay
deterministic: same field + text + font file -> same pixels. No Photoshop knowledge here;
`parse_psd.py` translates layers into the field dict this module consumes.

Field keys used (template px unless noted):
  box {x,y,w,h}, sizePx, color "#rrggbb", align left|center|right, anchor top|center|bottom,
  tracking (1/1000 em, Photoshop units), leading (px between baselines, optional),
  fit shrink|wrap|none, maxChars (optional), scaleX (optional horizontal stretch, default 1),
  charColors (optional list of "#rrggbb", cycled over non-space characters),
  stroke {px,color} (outside stroke), shadow {dx,dy,blur,color,opacity 0-1,spread 0-100 optional}.
"""
from __future__ import annotations

import math
from functools import lru_cache
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

LAYOUT_ENGINE = ImageFont.Layout.BASIC
MIN_SIZE_PX = 4.0
DEFAULT_LEADING = 1.2
# Photoshop drop-shadow "size" S ~ spread dilation + Gaussian sigma 0.4*S (fitted on a real PSD).
SHADOW_SIGMA_PER_SIZE = 0.4


def hex_to_rgb(color: str | None, default=(0, 0, 0)) -> tuple[int, int, int]:
    if not color or not isinstance(color, str):
        return default
    c = color.strip().lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    if len(c) != 6:
        return default
    try:
        return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    except ValueError:
        return default


def _face_index(path: str, postscript: str | None) -> int:
    if not postscript or not path.lower().endswith(('.ttc', '.otc')):
        return 0
    try:
        from fontTools.ttLib import TTCollection
        coll = TTCollection(path, lazy=True)
        for i, f in enumerate(coll.fonts):
            if f['name'].getDebugName(6) == postscript:
                return i
    except Exception:
        pass
    return 0


@lru_cache(maxsize=64)
def load_font(path: str, size_px: float, postscript: str | None = None) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=max(size_px, 1.0), index=_face_index(path, postscript),
                              layout_engine=LAYOUT_ENGINE)


def _track_px(field: dict, size: float) -> float:
    return float(field.get('tracking') or 0) / 1000.0 * size


def _per_char(field: dict) -> bool:
    return bool(field.get('tracking')) or bool(field.get('charColors'))


def line_width(font: ImageFont.FreeTypeFont, line: str, track: float) -> float:
    """Advance width in unscaled px. Tracking is added between characters, not after the last."""
    if not line:
        return 0.0
    return font.getlength(line) + track * max(len(line) - 1, 0)


def _metrics(font: ImageFont.FreeTypeFont, size: float, field: dict) -> tuple[float, float, float]:
    ascent, descent = font.getmetrics()
    lead = field.get('leading')
    lead = float(lead) * (size / float(field['sizePx'])) if lead else DEFAULT_LEADING * size
    return float(ascent), float(descent), lead


def _wrap(font, text: str, max_w: float, track: float) -> list[str]:
    out: list[str] = []
    for para in text.split('\n'):
        words = para.split(' ')
        cur = ''
        for w in words:
            cand = w if not cur else cur + ' ' + w
            if not cur or line_width(font, cand, track) <= max_w:
                cur = cand
            else:
                out.append(cur)
                cur = w
        out.append(cur)
    return out


def layout(field: dict, text: str, font_path: str) -> dict:
    """Resolve fit -> final size, lines and block metrics (unscaled x)."""
    text = (text or '').replace('\r\n', '\n').replace('\r', '\n')
    max_chars = field.get('maxChars')
    if max_chars:
        text = text[: int(max_chars)]
    box = field['box']
    scale_x = float(field.get('scaleX') or 1.0)
    fit = field.get('fit') or 'shrink'
    ps = field.get('font')
    size = float(field['sizePx'])
    avail_w = float(box['w']) / scale_x
    avail_h = float(box['h'])

    def measure(sz: float, wrap: bool):
        font = load_font(font_path, round(sz, 2), ps)
        track = _track_px(field, sz)
        lines = _wrap(font, text, avail_w, track) if wrap else text.split('\n')
        asc, desc, lead = _metrics(font, sz, field)
        widths = [line_width(font, ln, track) for ln in lines]
        block_h = asc + desc + lead * (len(lines) - 1)
        return font, track, lines, widths, asc, desc, lead, block_h

    m = measure(size, fit == 'wrap')
    if fit in ('shrink', 'wrap'):
        for _ in range(40):
            _, _, _, widths, _, _, _, block_h = m
            over = max(max(widths or [0.0]) / avail_w if avail_w > 0 else 1.0,
                       block_h / avail_h if avail_h > 0 else 1.0)
            if over <= 1.0005 or size <= MIN_SIZE_PX:
                break
            size = max(MIN_SIZE_PX, size / over if over > 1.02 else size * 0.98)
            m = measure(size, fit == 'wrap')
    font, track, lines, widths, asc, desc, lead, block_h = m
    return {'font': font, 'size': size, 'track': track, 'lines': lines, 'widths': widths,
            'ascent': asc, 'descent': desc, 'leading': lead, 'blockH': block_h, 'scaleX': scale_x}


def _draw_masks(lay: dict, field: dict, stroke_px: float, pad: int):
    font, track, lines, widths = lay['font'], lay['track'], lay['lines'], lay['widths']
    max_w = max(widths or [0.0])
    w = int(math.ceil(max_w)) + 2 * pad
    h = int(math.ceil(lay['blockH'])) + 2 * pad
    fill = Image.new('L', (max(w, 1), max(h, 1)), 0)
    stroke = Image.new('L', fill.size, 0) if stroke_px > 0 else None
    colors = [hex_to_rgb(c) for c in (field.get('charColors') or [])]
    color_masks: dict[tuple[int, int, int], Image.Image] = {}
    df = ImageDraw.Draw(fill)
    ds = ImageDraw.Draw(stroke) if stroke is not None else None
    align = field.get('align') or 'left'
    char_i = 0
    for i, line in enumerate(lines):
        lw = widths[i]
        off = 0.0 if align == 'left' else (max_w - lw if align == 'right' else (max_w - lw) / 2.0)
        x0 = pad + off
        base = pad + lay['ascent'] + i * lay['leading']
        if not _per_char(field):
            df.text((x0, base), line, font=font, fill=255, anchor='ls')
            if ds is not None:
                ds.text((x0, base), line, font=font, fill=255, anchor='ls', stroke_width=stroke_px, stroke_fill=255)
            continue
        for j, ch in enumerate(line):
            x = x0 + font.getlength(line[:j]) + j * lay['track']
            df.text((x, base), ch, font=font, fill=255, anchor='ls')
            if ds is not None:
                ds.text((x, base), ch, font=font, fill=255, anchor='ls', stroke_width=stroke_px, stroke_fill=255)
            if colors and not ch.isspace():
                c = colors[char_i % len(colors)]
                if c not in color_masks:
                    color_masks[c] = Image.new('L', fill.size, 0)
                ImageDraw.Draw(color_masks[c]).text((x, base), ch, font=font, fill=255, anchor='ls')
                char_i += 1
    return fill, stroke, color_masks, max_w


def _shadow_alpha(src: Image.Image, shadow: dict, k: float = 1.0) -> Image.Image:
    blur = float(shadow.get('blur') or 0) * k
    spread = float(shadow.get('spread') or 0) / 100.0
    a = src
    grow = blur * spread
    if grow >= 0.5:
        size = int(round(grow)) * 2 + 1
        a = a.filter(ImageFilter.MaxFilter(size))
    sigma = blur * (1.0 - spread) * SHADOW_SIGMA_PER_SIZE
    if sigma > 0.05:
        a = a.filter(ImageFilter.GaussianBlur(sigma))
    op = float(shadow.get('opacity') if shadow.get('opacity') is not None else 1.0)
    if op < 1.0:
        a = a.point(lambda v: int(round(v * op)))
    return a


def render_field(field: dict, text: str, font_path: str) -> tuple[Image.Image, tuple[int, int], dict]:
    """Return (RGBA patch, (x, y) top-left in template px, info)."""
    lay = layout(field, text, font_path)
    k = lay['size'] / float(field['sizePx'])
    stroke = field.get('stroke') or None
    stroke_px = float(stroke.get('px') or 0) * k if stroke else 0.0
    shadow = field.get('shadow') or None
    pad = int(math.ceil(stroke_px)) + 4
    fill_m, stroke_m, color_masks, max_w = _draw_masks(lay, field, stroke_px, pad)

    sx = lay['scaleX']
    if abs(sx - 1.0) > 1e-4:
        new_w = max(1, int(round(fill_m.width * sx)))
        rs = lambda im: im.resize((new_w, im.height), Image.LANCZOS) if im is not None else None
        fill_m, stroke_m = rs(fill_m), rs(stroke_m)
        color_masks = {c: rs(m) for c, m in color_masks.items()}

    box = field['box']
    content_w = max_w * sx
    align = field.get('align') or 'left'
    if align == 'left':
        cx0 = box['x']
    elif align == 'right':
        cx0 = box['x'] + box['w'] - content_w
    else:
        cx0 = box['x'] + (box['w'] - content_w) / 2.0
    anchor = field.get('anchor') or 'center'
    if anchor == 'top':
        top = box['y']
    elif anchor == 'bottom':
        top = box['y'] + box['h'] - lay['blockH']
    else:
        top = box['y'] + (box['h'] - lay['blockH']) / 2.0
    px = int(round(cx0 - pad * sx))
    py = int(round(top - pad))

    margin = 0
    sdx = sdy = 0
    if shadow:
        sdx = int(round(float(shadow.get('dx') or 0) * k))
        sdy = int(round(float(shadow.get('dy') or 0) * k))
        margin = int(math.ceil(max(abs(sdx), abs(sdy)) + float(shadow.get('blur') or 0) * k * 2 + 2))
    W, H = fill_m.width + 2 * margin, fill_m.height + 2 * margin
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    shape = stroke_m if stroke_m is not None else fill_m
    if shadow:
        sa = Image.new('L', (W, H), 0)
        sa.paste(shape, (margin + sdx, margin + sdy))
        sa = _shadow_alpha(sa, shadow, k)
        layer = Image.new('RGBA', (W, H), hex_to_rgb(shadow.get('color')) + (0,))
        layer.putalpha(sa)
        out = Image.alpha_composite(out, layer)
    if stroke_m is not None:
        layer = Image.new('RGBA', (W, H), hex_to_rgb(stroke.get('color')) + (0,))
        a = Image.new('L', (W, H), 0)
        a.paste(stroke_m, (margin, margin))
        layer.putalpha(a)
        out = Image.alpha_composite(out, layer)
    fa = Image.new('L', (W, H), 0)
    fa.paste(fill_m, (margin, margin))
    rgb = Image.new('RGB', (W, H), hex_to_rgb(field.get('color')))
    for c, m in color_masks.items():
        sel = Image.new('L', (W, H), 0)
        sel.paste(m.filter(ImageFilter.MaxFilter(3)), (margin, margin))
        rgb = Image.composite(Image.new('RGB', (W, H), c), rgb, sel)
    layer = rgb.convert('RGBA')
    layer.putalpha(fa)
    out = Image.alpha_composite(out, layer)

    info = {'sizePx': round(lay['size'], 2), 'lines': lay['lines'], 'fill': (fa, (px - margin, py - margin))}
    return out, (px - margin, py - margin), info


def draw_field(img: Image.Image, field: dict, text: str, font_path: str) -> dict[str, Any]:
    """Draw `text` for `field` onto `img` (RGBA, modified in place). Returns render info."""
    patch, (x, y), info = render_field(field, text, font_path)
    if img.mode != 'RGBA':
        raise ValueError('draw_field needs an RGBA image')
    img.alpha_composite(patch, dest=(max(x, 0), max(y, 0)), source=(max(-x, 0), max(-y, 0)))
    info = dict(info)
    info.pop('fill', None)
    return info


def ink_bbox(field: dict, text: str, font_path: str) -> tuple[int, int, int, int] | None:
    """Fill-only ink bbox (template px) of the text as draw_field would place it."""
    _, _, info = render_field(field, text, font_path)
    fa, (ox, oy) = info['fill']
    bb = fa.getbbox()
    if not bb:
        return None
    return bb[0] + ox, bb[1] + oy, bb[2] + ox, bb[3] + oy
