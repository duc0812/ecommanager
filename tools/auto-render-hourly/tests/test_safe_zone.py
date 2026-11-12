import safe_zone as sz

AREA = (0, 0, 1000, 800)
BOX = sz.NameBox('FRONT', 'Custom Name', (200, 100, 600, 200))


def test_overflow_inset_and_larger_clearance():
    assert sz.overflow((10, 10, 50, 30), AREA) <= 0
    assert sz.overflow((10, 10, 1004, 30), AREA) == 4
    assert sz.overflow((10, 10, 1004, 30), AREA, x=False) <= 0
    assert sz.inset_rect(AREA, 60) == (60, 60, 940, 740)
    assert sz.safe_inset_px(0.2, 300, None) == 60
    assert sz.safe_inset_px(0.2, 200, 148.49) == 148.49
    assert sz.safe_inset_px(None, 300, None) is None


def test_rotated_bounds():
    box = {'x': 100, 'y': 100, 'w': 200, 'h': 100}
    assert sz.rotated_bounds(box, 0, None) == (100, 100, 300, 200)
    assert [round(v) for v in sz.rotated_bounds(box, 90, None)] == [150, 50, 250, 250]


def test_lone_no():
    assert sz.lone_no([('Custom Name: Yes Or No?', 'No'), ('Custom Name', 'KANTORSKI')])
    assert not sz.lone_no([('Custom Name: Yes Or No?', 'No'), ('Custom Name Yes or No', 'Yes')])
    assert not sz.lone_no([('Choose Back Design', 'No')])
    assert sz.lone_no([('_Enter Name:', 'no')], fields=('Enter Name',))


def test_judge_box_safe_unchecked_pass():
    assert sz.judge([BOX], [(210, 110, 590, 190)], AREA, 60).verdict == 'PASS'
    assert sz.judge([BOX], [(210, 110, 603, 190)], AREA, 60).verdict == 'PASS'          # 3 px tolerated
    r = sz.judge([BOX], [(210, 110, 605, 190)], AREA, 60)
    assert (r.verdict, r.guard, r.reason) == ('HOLD', 'BOX', 'tên vượt khung 5 px (FRONT · Custom Name)')
    size_fit = sz.NameBox('FRONT', 'Custom Name', (200, 100, 600, 200), check_y=False)
    assert sz.judge([size_fit], [(210, 110, 590, 320)], AREA, 60).verdict == 'PASS'     # descender below a fit:size box
    edge = sz.NameBox('FRONT', 'Custom Name', (20, 100, 420, 200))
    r = sz.judge([edge], [(30, 110, 400, 190)], AREA, 60)
    assert (r.guard, r.reason) == ('SAFE', 'tên chạm safe zone: lấn 40 px vào mép an toàn 60 px (FRONT · Custom Name)')
    r = sz.judge([BOX], [(210, 110, 590, 190)], AREA, None)
    assert (r.verdict, r.reason) == ('UNCHECKED', 'không kiểm được safe zone (không có template)')
    assert sz.judge([BOX], [None], AREA, 60, box_overflow=9).guard == 'BOX'
