import numpy as np
import pytest
from PIL import Image

from conftest import ARIAL, need
import textrender as tr

GOLD = {
    'type': 'linear', 'angle': 0, 'scale': 100, 'offset': {'x': 0, 'y': 0}, 'align': True, 'reverse': False,
    'opacity': 1.0, 'interpolation': 'classic', 'smoothness': 0,
    'stops': [{'pos': 0, 'color': '#000000', 'mid': 0.5}, {'pos': 1, 'color': '#ffffff', 'mid': 0.5}],
}
BEVEL = {
    'technique': 'chiselHard', 'depth': 300, 'direction': 'up', 'size': 6, 'soften': 0, 'angle': 0, 'altitude': 30,
    'highlight': {'color': '#ffffff', 'opacity': 1.0, 'mode': 'screen'},
    'shadow': {'color': '#000000', 'opacity': 1.0, 'mode': 'multiply'},
}


def field(**kw):
    f = {'field': 'Name', 'layer': '@Name', 'sample': 'I', 'font': 'ArialMT', 'sizePx': 200.0, 'color': '#808080',
         'align': 'center', 'box': {'x': 50, 'y': 50, 'w': 300, 'h': 260}, 'anchor': 'center', 'tracking': 0, 'fit': 'none'}
    f.update(kw)
    return f


def render(f, text='I'):
    need(ARIAL)
    img = Image.new('RGBA', (400, 360), (0, 0, 0, 0))
    tr.draw_field(img, f, text, ARIAL)
    return img


def test_gradient_lut_endpoints_and_midpoint():
    rgb, alpha = tr.gradient_lut(GOLD, 101)
    assert rgb[0] == pytest.approx([0, 0, 0]) and rgb[-1] == pytest.approx([1, 1, 1])
    assert rgb[50] == pytest.approx([0.5, 0.5, 0.5], abs=0.01)
    assert (alpha == 1).all()
    # the midpoint belongs to the segment that ends at the stop: 0.25 -> half colour at t=0.25
    g = dict(GOLD, stops=[GOLD['stops'][0], dict(GOLD['stops'][1], mid=0.25)])
    rgb, _ = tr.gradient_lut(g, 101)
    assert rgb[25] == pytest.approx([0.5, 0.5, 0.5], abs=0.01)


def test_gradient_interpolation_spaces_differ_in_the_middle():
    lin, _ = tr.gradient_lut(dict(GOLD, interpolation='linear'), 101)
    srgb, _ = tr.gradient_lut(GOLD, 101)
    perc, _ = tr.gradient_lut(dict(GOLD, interpolation='perceptual'), 101)
    assert lin[50][0] > srgb[50][0]  # linear-light midpoint is brighter in sRGB
    assert 0.3 < perc[50][0] < 0.7


def test_gradient_image_geometry_angle_scale_offset_reverse():
    rgb, _ = tr.gradient_image(GOLD, 100, 10, (0, 0, 100, 10))
    assert rgb[5, 0, 0] < 0.05 and rgb[5, -1, 0] > 0.95 and rgb[5, 50, 0] == pytest.approx(0.5, abs=0.02)
    rev, _ = tr.gradient_image(dict(GOLD, reverse=True), 100, 10, (0, 0, 100, 10))
    assert rev[5, 0, 0] > 0.95
    half, _ = tr.gradient_image(dict(GOLD, scale=50), 100, 10, (0, 0, 100, 10))
    assert half[5, 20, 0] < 0.05 and half[5, 80, 0] > 0.95
    moved, _ = tr.gradient_image(dict(GOLD, offset={'x': 20, 'y': 0}), 100, 10, (0, 0, 100, 10))
    assert moved[5, 70, 0] == pytest.approx(0.5, abs=0.02)
    up, _ = tr.gradient_image(dict(GOLD, angle=90), 10, 100, (0, 0, 10, 100))
    assert up[0, 5, 0] > 0.95 and up[-1, 5, 0] < 0.05  # 90 deg runs bottom -> top


def test_gradient_overlay_follows_the_text_box():
    f = field(sample='II', gradient=GOLD)
    img = render(f, 'II')
    bb = tr.ink_bbox(f, 'II', ARIAL)
    y = (bb[1] + bb[3]) // 2
    left = img.getpixel((bb[0] + 2, y))
    right = img.getpixel((bb[2] - 3, y))
    assert left[3] == 255 and right[3] == 255
    assert left[0] < 60 and right[0] > 190


def test_bevel_lights_the_side_facing_the_light():
    flat = render(field())
    lit = render(field(bevel=BEVEL))  # light from the right (angle 0)
    f = field()
    bb = tr.ink_bbox(f, 'I', ARIAL)
    y = (bb[1] + bb[3]) // 2
    mid = (bb[0] + bb[2]) // 2
    assert lit.getpixel((bb[2] - 3, y))[0] > flat.getpixel((bb[2] - 3, y))[0] + 40  # right edge highlighted
    assert lit.getpixel((bb[0] + 2, y))[0] < flat.getpixel((bb[0] + 2, y))[0] - 40  # left edge in shadow
    assert lit.getpixel((mid, y))[:3] == flat.getpixel((mid, y))[:3]  # flat face untouched (linear contour)
    down = render(field(bevel=dict(BEVEL, direction='down')))
    assert down.getpixel((bb[2] - 3, y))[0] < flat.getpixel((bb[2] - 3, y))[0]


def test_gloss_contour_tints_the_flat_face():
    ring = [[0, 0], [32, 110], [64, 237], [96, 239], [128, 138], [159, 32], [191, 6], [223, 99], [255, 255]]
    img = render(field(bevel=dict(BEVEL, contour=ring)))
    flat = render(field())
    bb = tr.ink_bbox(field(), 'I', ARIAL)
    p = ((bb[0] + bb[2]) // 2, (bb[1] + bb[3]) // 2)
    assert img.getpixel(p)[0] > flat.getpixel(p)[0]  # Photoshop's Ring lifts the face a little


def test_styles_are_deterministic_and_keep_alpha():
    f = field(gradient=GOLD, bevel=dict(BEVEL, soften=2),
              shadow={'dx': 5, 'dy': 5, 'blur': 4, 'color': '#000000', 'opacity': 1.0, 'spread': 20})
    a, b = render(f), render(f)
    assert a.tobytes() == b.tobytes()
    plain = render(field(shadow=f['shadow']))
    assert np.array_equal(np.asarray(a)[..., 3], np.asarray(plain)[..., 3])
