from PIL import Image

import safe_zone as sz
from conftest import make_piece

FIELD = {'field': 'Custom Name', 'box': {'x': 200, 'y': 100, 'w': 200, 'h': 60}}
AREA = (0, 0, 600, 400)


def piece(tmp_path, ink=None, shade=0, base_size=None):
    return make_piece(tmp_path / 'base.png', tmp_path / 'render.png', ink=ink, shade=shade, size=base_size or (600, 400))


def check(tmp_path, ink, name='6001_1_Print_auto.png', no=False, inset=30, **kw):
    render, base = piece(tmp_path, ink=ink, shade=kw.pop('shade', 0))
    return sz.check_worker_piece(render, kw.pop('base', base), kw.pop('fields', [FIELD]), name, no, AREA, inset, **kw)


def test_name_inside_its_box_passes(tmp_path):
    assert check(tmp_path, (210, 110, 390, 150)).verdict == 'PASS'


def test_name_past_the_box_is_held(tmp_path):
    assert check(tmp_path, (210, 110, 403, 150)).verdict == 'PASS'
    r = check(tmp_path, (210, 110, 405, 150))
    assert (r.verdict, r.guard, r.reason) == ('HOLD', 'BOX', 'tên vượt khung 5 px (Print · Custom Name)')


def test_box_in_the_safe_margin_is_held(tmp_path):
    edge = {'field': 'Custom Name', 'box': {'x': 10, 'y': 100, 'w': 200, 'h': 60}}
    assert check(tmp_path, (20, 110, 200, 150), fields=[edge]).guard == 'SAFE'


def test_lone_no(tmp_path):
    assert check(tmp_path, None, name='6001_1_Print_auto-noname.png', no=True).verdict == 'PASS'
    assert check(tmp_path, None, name='6001_1_Print_auto.png', no=True).reason == 'khách chọn No nhưng file in có tên'
    assert check(tmp_path, (210, 110, 390, 150), name='6001_1_Print_auto-noname.png', no=True).guard == 'NO'


def test_faint_shadow_is_not_ink_and_missing_name_is_held(tmp_path):
    r = check(tmp_path, (150, 90, 450, 190), shade=20)
    assert (r.guard, r.reason) == ('BOX', 'file dựng không thấy tên (Print)')


def test_missing_library_artwork_is_unchecked(tmp_path):          # Review Focus 5
    r = check(tmp_path, (210, 110, 390, 150), base=tmp_path / 'gone.png')
    assert (r.verdict, r.reason) == ('UNCHECKED', 'không kiểm được safe zone (thiếu artwork gốc để so)')


def test_photoshop_rule_uses_its_targets(tmp_path):
    rule = {'targets': [{'cx': 300, 'cy': 130}], 'maxW': 200, 'maxH': 60}
    r = check(tmp_path, (0, 0, 600, 400), photoshop_rule=rule)     # whole canvas differs: not measured
    assert r.verdict == 'PASS' and r.details['inkSource'] == 'renderer'
    assert check(tmp_path, None, photoshop_rule={'targets': [{'cx': 80, 'cy': 130}], 'maxW': 200, 'maxH': 60}).guard == 'SAFE'


def test_base_of_another_size_is_resized(tmp_path):
    render, _ = piece(tmp_path, ink=(210, 110, 390, 150))
    small = tmp_path / 'small.png'; Image.open(tmp_path / 'base.png').resize((300, 200)).save(small)
    assert sz.check_worker_piece(render, small, [FIELD], 'x_auto.png', False, AREA, 30).verdict in ('PASS', 'HOLD')
