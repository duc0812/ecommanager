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
  gradient (Gradient Overlay, normal blend) {type linear, angle deg, scale %, offset {x,y} % of the
    reference box, align (true = box is the text's ink bbox, false = `frame` {x,y,w,h} template px),
    reverse, opacity 0-1, interpolation perceptual|linear|classic, smoothness 0-1,
    stops [{pos 0-1, color, mid 0-1 = midpoint of the segment that ENDS at this stop}],
    alphaStops optional [{pos, opacity 0-1, mid}]}.
  bevel (inner Bevel & Emboss) {technique smooth|chiselHard|chiselSoft, depth %, direction up|down,
    size px, soften px, angle deg, altitude deg, contour optional [[in 0-255, out 0-255], ...],
    highlight {color, opacity 0-1, mode}, shadow {color, opacity 0-1, mode}};
    modes: normal|screen|multiply|linearDodge|overlay.
Effects are drawn in Photoshop's order: drop shadow, stroke, fill (+ gradient overlay), bevel.
"""
from __future__ import annotations

import math
from functools import lru_cache
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage

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


# ---------------------------------------------------------------- gradient overlay

GRADIENT_LUT = 2048
# Fitted on a real PSD (gold name, Photoshop 2025 "Perceptual" gradient): see README.
BEVEL_SOFTEN_SIGMA = 1.0
BEVEL_SUPERSAMPLE = 4


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


_OK_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                   [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]])
_OK_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                   [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]])


def _to_oklab(rgb: np.ndarray) -> np.ndarray:
    lms = _srgb_to_linear(rgb) @ _OK_M1.T
    return np.cbrt(lms) @ _OK_M2.T


def _from_oklab(lab: np.ndarray) -> np.ndarray:
    lms = (lab @ np.linalg.inv(_OK_M2).T) ** 3
    return _linear_to_srgb(lms @ np.linalg.inv(_OK_M1).T)


def _segment_curve(u: np.ndarray, mid: float, smooth: float) -> np.ndarray:
    m = min(max(float(mid), 0.01), 0.99)
    f = np.where(u <= m, 0.5 * u / m, 0.5 + 0.5 * (u - m) / (1 - m))
    if smooth > 0:
        f = f + (f * f * (3 - 2 * f) - f) * smooth
    return f


def _ramp(stops: list[dict], n: int, smooth: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For n samples of t in [0,1]: (index of the left stop, index of the right stop, blend 0-1)."""
    t = np.linspace(0.0, 1.0, n)
    pos = np.array([float(s.get('pos', 0)) for s in stops])
    left = np.zeros(n, dtype=int)
    right = np.zeros(n, dtype=int)
    f = np.zeros(n)
    for i in range(n):
        j = int(np.searchsorted(pos, t[i], side='right'))
        if j <= 0:
            left[i] = right[i] = 0
        elif j >= len(stops):
            left[i] = right[i] = len(stops) - 1
        else:
            a, b = pos[j - 1], pos[j]
            u = 0.0 if b <= a else (t[i] - a) / (b - a)
            left[i], right[i] = j - 1, j
            f[i] = float(_segment_curve(np.array(u), float(stops[j].get('mid', 0.5)), smooth))
    return left, right, f


def gradient_lut(g: dict, n: int = GRADIENT_LUT) -> tuple[np.ndarray, np.ndarray]:
    """(n,3) sRGB 0-1 colours and (n,) alpha 0-1 along the gradient."""
    stops = sorted(g.get('stops') or [{'pos': 0, 'color': '#000000'}, {'pos': 1, 'color': '#ffffff'}],
                   key=lambda s: float(s.get('pos', 0)))
    interp = g.get('interpolation') or 'perceptual'
    smooth = float(g.get('smoothness') or 0) if interp == 'classic' else 0.0
    cols = np.array([hex_to_rgb(s.get('color')) for s in stops], dtype=np.float64) / 255.0
    li, ri, f = _ramp(stops, n, smooth)
    f = f[:, None]
    if interp == 'perceptual':
        lab = _to_oklab(cols)
        rgb = _from_oklab(lab[li] * (1 - f) + lab[ri] * f)
    elif interp == 'linear':
        lin = _srgb_to_linear(cols)
        rgb = _linear_to_srgb(lin[li] * (1 - f) + lin[ri] * f)
    else:
        rgb = cols[li] * (1 - f) + cols[ri] * f
    astops = sorted(g.get('alphaStops') or [], key=lambda s: float(s.get('pos', 0)))
    if astops:
        ops = np.array([float(s.get('opacity', 1)) for s in astops])
        al, ar, af = _ramp(astops, n, 0.0)
        alpha = ops[al] * (1 - af) + ops[ar] * af
    else:
        alpha = np.ones(n)
    return np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)


def gradient_image(g: dict, w: int, h: int, ref: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    """Photoshop linear gradient over a (h, w) patch. `ref` = reference box (x0, y0, x1, y1) in patch px."""
    x0, y0, x1, y1 = ref
    bw, bh = max(x1 - x0, 1.0), max(y1 - y0, 1.0)
    off = g.get('offset') or {}
    cx = x0 + bw / 2.0 + float(off.get('x') or 0) / 100.0 * bw
    cy = y0 + bh / 2.0 + float(off.get('y') or 0) / 100.0 * bh
    th = math.radians(float(g.get('angle') or 0))
    dx, dy = math.cos(th), -math.sin(th)
    length = (abs(bw * dx) + abs(bh * dy)) * float(g.get('scale') or 100) / 100.0
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    t = 0.5 + ((xs + 0.5 - cx) * dx + (ys + 0.5 - cy) * dy) / max(length, 1e-6)
    if g.get('reverse'):
        t = 1.0 - t
    rgb, alpha = gradient_lut(g)
    idx = np.clip(np.rint(t * (GRADIENT_LUT - 1)), 0, GRADIENT_LUT - 1).astype(int)
    return rgb[idx], alpha[idx]


# ---------------------------------------------------------------- bevel & emboss (inner bevel)

def _contour(points, v: np.ndarray) -> np.ndarray:
    if not points or len(points) < 2:
        return v
    xs = np.array([float(p[0]) for p in points]) / 255.0
    ys = np.array([float(p[1]) for p in points]) / 255.0
    order = np.argsort(xs)
    return np.interp(v, xs[order], ys[order])


def bevel_maps(alpha: np.ndarray, bevel: dict, k: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Highlight and shadow strengths (0-1) inside the shape. `alpha` is the fill coverage 0-1."""
    size = max(float(bevel.get('size') or 0) * k, 0.5)
    inside = alpha >= 0.5
    if not inside.any():
        z = np.zeros_like(alpha)
        return z, z
    # distance to the edge measured on a supersampled mask: a plain pixel EDT steps along diagonal edges,
    # which the steep bevel slopes turn into dotted highlights
    ss = BEVEL_SUPERSAMPLE
    big = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).resize(
        (alpha.shape[1] * ss, alpha.shape[0] * ss), Image.BILINEAR), dtype=np.float64) >= 127.5
    d = ndimage.distance_transform_edt(big) / ss
    d = d.reshape(alpha.shape[0], ss, alpha.shape[1], ss).mean(axis=(1, 3))
    tech = bevel.get('technique') or 'smooth'
    if tech == 'smooth':
        h = ndimage.gaussian_filter(alpha, sigma=size / 2.0)
        h = np.clip(h, 0, 1)
    else:
        h = np.clip(d / size, 0.0, 1.0)
        if tech == 'chiselSoft':
            h = ndimage.gaussian_filter(h, sigma=max(size / 6.0, 0.5))
    soften = float(bevel.get('soften') or 0) * k
    if soften > 0:
        h = ndimage.gaussian_filter(h, sigma=soften * BEVEL_SOFTEN_SIGMA)
    if (bevel.get('direction') or 'up') == 'down':
        h = -h
    hz = h * size * float(bevel.get('depth') or 100) / 100.0
    gy, gx = np.gradient(hz)
    norm = np.sqrt(gx * gx + gy * gy + 1.0)
    th = math.radians(float(bevel.get('angle') if bevel.get('angle') is not None else 120))
    al = math.radians(float(bevel.get('altitude') if bevel.get('altitude') is not None else 30))
    lx, ly, lz = math.cos(al) * math.cos(th), -math.cos(al) * math.sin(th), math.sin(al)
    shade = np.clip((-gx * lx - gy * ly + lz) / norm, 0.0, 1.0)
    curve = bevel.get('contour')
    g = _contour(curve, shade)
    # the flat face is compared with the un-contoured light level: a gloss contour that lifts sin(altitude)
    # tints the whole face (Photoshop does this too, e.g. "Ring" adds ~6% highlight at altitude 30)
    g0 = math.sin(al)
    hi = np.clip((g - g0) / max(1.0 - g0, 1e-6), 0, 1)
    sh = np.clip((g0 - g) / max(g0, 1e-6), 0, 1)
    return hi * alpha, sh * alpha


def _blend(base: np.ndarray, color: np.ndarray, a: np.ndarray, mode: str) -> np.ndarray:
    a = a[..., None]
    if mode == 'screen':
        top = 1 - (1 - base) * (1 - color)
    elif mode == 'multiply':
        top = base * color
    elif mode == 'linearDodge':
        top = np.clip(base + color, 0, 1)
    elif mode == 'overlay':
        top = np.where(base < 0.5, 2 * base * color, 1 - 2 * (1 - base) * (1 - color))
    else:
        top = np.broadcast_to(color, base.shape)
    return base * (1 - a) + top * a


def _styled_fill(rgb: Image.Image, fa: Image.Image, field: dict, k: float, origin: tuple[int, int] = (0, 0)) -> Image.Image:
    """Apply gradient overlay and bevel to the fill colour image (RGB, same size as the fill alpha)."""
    g = field.get('gradient') or None
    bevel = field.get('bevel') or None
    if not g and not bevel:
        return rgb
    base = np.asarray(rgb, dtype=np.float64) / 255.0
    alpha = np.asarray(fa, dtype=np.float64) / 255.0
    H, W = alpha.shape
    if g:
        if g.get('align', True) or not g.get('frame'):
            bb = fa.getbbox()
            ref = bb if bb else (0, 0, W, H)
        else:
            fr = g['frame']
            ox, oy = origin
            ref = (fr['x'] - ox, fr['y'] - oy, fr['x'] + fr['w'] - ox, fr['y'] + fr['h'] - oy)
        grgb, galpha = gradient_image(g, W, H, ref)
        op = float(g.get('opacity') if g.get('opacity') is not None else 1.0)
        base = _blend(base, grgb, galpha * op, 'normal')
    if bevel:
        hi, sh = bevel_maps(alpha, bevel, k)
        for part, amount in (('shadow', sh), ('highlight', hi)):
            p = bevel.get(part) or {}
            op = float(p.get('opacity') if p.get('opacity') is not None else 0.75)
            col = np.array(hex_to_rgb(p.get('color'), (255, 255, 255) if part == 'highlight' else (0, 0, 0))) / 255.0
            default = 'screen' if part == 'highlight' else 'multiply'
            base = _blend(base, col, amount * op, p.get('mode') or default)
    return Image.fromarray(np.clip(np.rint(base * 255), 0, 255).astype(np.uint8), 'RGB')


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
    rgb = _styled_fill(rgb, fa, field, k, (px - margin, py - margin))
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
