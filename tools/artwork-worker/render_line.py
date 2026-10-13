"""Per-order step: draw a customer's values onto an entry's artwork.png at template size.

render_line(artwork, fields, values, font_lookup, template) -> (print RGBA image, preview RGB image, info)

* Every field entry is drawn with the customer value of its `field` name, so a field placed twice in the
  PSD (two placements) gets the name twice.
* `fit` (default shrink) keeps long values inside the box; `anchor` (default center) keeps the visual
  centre where the PSD's sample text was.
* The print file is template px, sRGB (ICC profile embedded), with the template DPI in the PNG pHYs chunk.
"""
from __future__ import annotations

import io
from typing import Callable

from PIL import Image, ImageCms

import textrender

PREVIEW_MAX = 1200


class RenderError(Exception):
    """Permanent: the job can't succeed by retrying (missing value, font or artwork)."""


def _srgb_icc() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()


def missing_glyphs(font_path: str, text: str) -> list[str]:
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(font_path, lazy=True, fontNumber=0)
        cmap = f.getBestCmap() or {}
    except Exception:
        return []
    return sorted({ch for ch in text if not ch.isspace() and ord(ch) not in cmap})


def render_line(artwork: Image.Image, fields: list[dict], values: dict[str, str],
                font_lookup: Callable[[str], str | None], template: dict) -> tuple[Image.Image, Image.Image, dict]:
    tw, th = int(template['widthPx']), int(template['heightPx'])
    warnings: list[str] = []
    img = artwork.convert('RGBA')
    if img.size != (tw, th):
        warnings.append(f'artwork.png {img.width}x{img.height} px resized to the template {tw}x{th} px')
        img = img.resize((tw, th), Image.LANCZOS)
    drawn = []
    for f in fields:
        name = f.get('field') or ''
        value = values.get(name)
        if value is None or not str(value).strip():
            raise RenderError(f'Thiếu giá trị cho trường "{name}"')
        path = font_lookup(f.get('font') or '')
        if not path:
            raise RenderError(f'Thiếu font {f.get("font") or "?"} trong thư viện')
        synth = textrender.accent_subst(path, str(value))
        gaps = [g for g in missing_glyphs(path, value) if g not in synth]
        if synth:
            warnings.append(f'Font {f.get("font")} không có {" ".join(sorted(synth))}: đã vẽ chữ gốc + dấu tự dựng — kiểm tra lại ({name})')
        if gaps:
            warnings.append(f'Font {f.get("font")} không có ký tự {" ".join(gaps)} ({name})')
        info = textrender.draw_field(img, f, str(value), path)
        drawn.append({'field': name, 'layer': f.get('layer'), 'value': value, 'sizePx': info['sizePx'],
                      'sampleSizePx': f.get('sizePx'), 'lines': info['lines']})
        if info['sizePx'] < 0.6 * float(f.get('sizePx') or 0):
            warnings.append(f'"{value}" thu nhỏ còn {round(100 * info["sizePx"] / float(f["sizePx"]))}% để vừa khung ({name})')
    preview = Image.new('RGB', img.size, (255, 255, 255))
    preview.paste(img, mask=img.getchannel('A'))
    preview.thumbnail((PREVIEW_MAX, PREVIEW_MAX), Image.LANCZOS)
    return img, preview, {'fields': drawn, 'warnings': list(dict.fromkeys(warnings)), 'widthPx': tw, 'heightPx': th}


def print_png(img: Image.Image, dpi: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG', dpi=(dpi, dpi), icc_profile=_srgb_icc(), compress_level=6)
    return buf.getvalue()


def preview_jpg(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert('RGB').save(buf, format='JPEG', quality=85, optimize=True)
    return buf.getvalue()
