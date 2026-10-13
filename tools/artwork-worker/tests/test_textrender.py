import pytest
from PIL import Image

from conftest import ARIAL, need
import textrender as tr


def base_field(**kw):
    f = {'field': 'Name', 'layer': '@Name', 'sample': 'Rachel', 'font': 'ArialMT', 'sizePx': 100.0,
         'color': '#ff0000', 'align': 'center', 'box': {'x': 100, 'y': 100, 'w': 600, 'h': 140},
         'anchor': 'center', 'tracking': 0, 'fit': 'shrink'}
    f.update(kw)
    return f


@pytest.fixture(autouse=True)
def _font():
    need(ARIAL)


def render(field, text):
    img = Image.new('RGBA', (800, 400), (255, 255, 255, 0))
    info = tr.draw_field(img, field, text, ARIAL)
    return img, info


def test_deterministic():
    f = base_field(stroke={'px': 4, 'color': '#000000'},
                   shadow={'dx': 6, 'dy': 6, 'blur': 8, 'color': '#000000', 'opacity': 0.5})
    a, _ = render(f, 'Rachel')
    b, _ = render(f, 'Rachel')
    assert a.tobytes() == b.tobytes()


def test_shrink_fits_long_text_in_box():
    f = base_field()
    _, info = render(f, 'Bartholomew-Alexandria Montgomery')
    assert info['sizePx'] < 100
    bb = tr.ink_bbox(f, 'Bartholomew-Alexandria Montgomery', ARIAL)
    assert bb[0] >= 100 - 1 and bb[2] <= 700 + 1


def test_fit_none_keeps_size():
    _, info = render(base_field(fit='none'), 'Bartholomew-Alexandria Montgomery')
    assert info['sizePx'] == 100


def test_wrap_breaks_lines():
    f = base_field(fit='wrap', box={'x': 100, 'y': 50, 'w': 400, 'h': 300})
    _, info = render(f, 'Grandma Grandpa Family')
    assert len(info['lines']) >= 2


def test_alignment():
    left = tr.ink_bbox(base_field(align='left'), 'Hi', ARIAL)
    right = tr.ink_bbox(base_field(align='right'), 'Hi', ARIAL)
    center = tr.ink_bbox(base_field(align='center'), 'Hi', ARIAL)
    assert abs(left[0] - 100) <= 12
    assert abs(right[2] - 700) <= 12
    assert abs((center[0] + center[2]) / 2 - 400) <= 6


def test_anchor_center_and_top():
    c = tr.ink_bbox(base_field(), 'H', ARIAL)
    t = tr.ink_bbox(base_field(anchor='top'), 'H', ARIAL)
    assert t[1] < c[1]


def test_tracking_and_scalex_widen_text():
    w0 = tr.ink_bbox(base_field(fit='none'), 'Rachel', ARIAL)
    wt = tr.ink_bbox(base_field(fit='none', tracking=200), 'Rachel', ARIAL)
    ws = tr.ink_bbox(base_field(fit='none', scaleX=1.5), 'Rachel', ARIAL)
    width = lambda b: b[2] - b[0]
    assert width(wt) == pytest.approx(width(w0) + 5 * 20, abs=4)
    assert width(ws) == pytest.approx(width(w0) * 1.5, rel=0.03)


def test_char_colors_cycle_over_letters():
    f = base_field(fit='none', charColors=['#ff0000', '#0000ff'])
    img, _ = render(f, 'II')
    bb = tr.ink_bbox(f, 'II', ARIAL)
    mid_y = (bb[1] + bb[3]) // 2
    row = [img.getpixel((x, mid_y)) for x in range(bb[0], bb[2])]
    solid = [p for p in row if p[3] == 255]
    assert solid[0][:3] == (255, 0, 0) and solid[-1][:3] == (0, 0, 255)


def test_shadow_offset_and_stroke_colour():
    f = base_field(fit='none', color='#ffffff', stroke={'px': 3, 'color': '#00ff00'},
                   shadow={'dx': 10, 'dy': 10, 'blur': 0, 'color': '#000000', 'opacity': 1.0})
    img, _ = render(f, 'I')
    bb = tr.ink_bbox(f, 'I', ARIAL)
    assert img.getpixel((bb[2] + 9, bb[3] + 9))[:3] == (0, 0, 0)
    assert img.getpixel((bb[0] - 2, (bb[1] + bb[3]) // 2))[:3] == (0, 255, 0)


def test_max_chars_truncates():
    a = tr.ink_bbox(base_field(fit='none', maxChars=3), 'Rachel', ARIAL)
    b = tr.ink_bbox(base_field(fit='none'), 'Rac', ARIAL)
    assert a == b


def test_synthesized_accents_keep_layout_and_add_ink():
    """A font without é draws e + a mark: same advance widths as the plain name, extra ink above."""
    import os
    import pytest
    from textrender import accent_subst, layout, render_field
    font = r'C:\Windows\Fonts\arial.ttf'
    if not os.path.exists(font):
        pytest.skip('needs a system font')
    assert accent_subst(font, 'César') == {}  # Arial has é: nothing is synthesized
    fake = {'é': ('e', 'acute')}
    field = {'box': {'x': 0, 'y': 0, 'w': 900, 'h': 300}, 'sizePx': 120, 'color': '#000000', 'align': 'center', 'anchor': 'center', 'fit': 'shrink'}
    plain = layout(field, 'Cesar', font)
    import textrender
    orig = textrender.accent_subst
    textrender.accent_subst = lambda path, text: {c: fake[c] for c in set(text) if c in fake}
    try:
        acc = layout(field, 'César', font)
        assert acc['widths'] == plain['widths'] and acc['size'] == plain['size']
        p1, pos1, i1 = render_field(field, 'Cesar', font)
        p2, pos2, i2 = render_field(field, 'César', font)
    finally:
        textrender.accent_subst = orig
    b1 = i1['fill'][0].getbbox(); b2 = i2['fill'][0].getbbox()
    top1 = b1[1] + i1['fill'][1][1]; top2 = b2[1] + i2['fill'][1][1]
    assert top2 < top1  # the mark rises above the plain letters
    assert abs((b1[0] + i1['fill'][1][0]) - (b2[0] + i2['fill'][1][0])) <= 1  # letters did not move sideways
