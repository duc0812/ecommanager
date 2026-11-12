import sys

import pytest

import safe_zone as sz

TEXT = {'area': 'FRONT', 'field': 'Custom Name', 'box': [300, 300, 700, 380], '_ink': [200, 60]}


@pytest.fixture(autouse=True)
def _bind(flat_spec, render):
    globals()['flat_spec'] = flat_spec
    globals()['render'] = render


def run(tmp_path, fake_tools, text, values, said_no=False, safe_in=0.2, files=None, **spec_keys):
    spec = flat_spec(tmp_path, [text], **spec_keys)
    files = files if files is not None else render(spec, 'LIT1_1', **values)
    return sz.check_flat_line('LIT1_1', spec, values, said_no, files, tmp_path / '_out', safe_in, fake_tools, sys.executable, tmp_path / 'tmp')


def test_name_in_box_passes(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}).verdict == 'PASS'


def test_wide_name_is_held_with_the_overflow(tmp_path, fake_tools):
    r = run(tmp_path, fake_tools, {**TEXT, '_ink': [420, 60]}, {'Custom Name': 'Anna'})
    assert (r.guard, r.reason) == ('BOX', 'tên vượt khung 10 px (FRONT · Custom Name)')


def test_glow_halo_is_not_ink(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, {**TEXT, 'glow': [{'px': 10}], '_ink': [398, 60]}, {'Custom Name': 'Anna'}).verdict == 'PASS'


def test_fit_size_box_bounds_only_the_running_axis(tmp_path, fake_tools):
    tall = {**TEXT, 'fit': 'size', '_ink': [200, 140]}                       # 60 px below the box
    assert run(tmp_path, fake_tools, tall, {'Custom Name': 'Anna'}).verdict == 'PASS'
    assert run(tmp_path, fake_tools, {**tall, 'fit': 'box'}, {'Custom Name': 'Anna'}).guard == 'BOX'


def test_safe_zone_uses_the_larger_of_safe_in_and_cut_clearance(tmp_path, fake_tools):
    low = {**TEXT, 'box': [300, 700, 700, 770]}                              # 30 px from the bottom edge
    assert run(tmp_path, fake_tools, low, {'Custom Name': 'Anna'}, safe_in=0.1).verdict == 'PASS'    # inset 20 px
    assert run(tmp_path, fake_tools, low, {'Custom Name': 'Anna'}, safe_in=0.2).guard == 'SAFE'      # inset 40 px
    r = run(tmp_path, fake_tools, low, {'Custom Name': 'Anna'}, safe_in=0.1,
            sleeveRevision={'files': [{'area': 'FRONT', 'minimumCutClearancePx': 148.49}]})
    assert r.guard == 'SAFE' and r.details['insetPx'] == 148.49
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}, safe_in=None).verdict == 'UNCHECKED'


def test_lone_no(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}, said_no=True).reason == 'khách chọn No nhưng file in có tên'
    assert run(tmp_path, fake_tools, TEXT, {}, said_no=True).verdict == 'PASS'              # file equals the no-name render
    spec = flat_spec(tmp_path, [TEXT]); named = render(spec, 'LIT1_1', **{'Custom Name': 'Anna'})
    assert run(tmp_path, fake_tools, TEXT, {}, said_no=True, files=named).guard == 'NO'     # stale named file on disk
    links = [{'printArea': 'FRONT', 'driveFileId': 'abc'}]
    assert run(tmp_path, fake_tools, TEXT, {}, said_no=True, files=links).verdict == 'PASS'


def test_photoshop_spec_and_renderer_crash(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}, photoshop=True).verdict == 'UNCHECKED'
    r = run(tmp_path, fake_tools, {**TEXT, '_ink': 'oops'}, {'Custom Name': 'Anna'})
    assert r.verdict == 'ERROR' and r.reason.startswith('không đo được khung tên: ')


def test_nothing_is_written_next_to_the_renderer(tmp_path, fake_tools):
    run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'})
    assert sorted(p.name for p in fake_tools.iterdir()) == ['name_render.py']


def test_lone_no_with_a_text_area_missing_from_the_spec_is_an_error(tmp_path, fake_tools):
    back = {'area': 'BACK', 'field': 'Custom Name', 'box': [300, 300, 700, 380], '_ink': [200, 60]}
    spec = flat_spec(tmp_path, [back])
    files = [{'printArea': 'BACK', 'path': 'x/LIT1_1 - BACK.png', 'widthPx': 1000, 'heightPx': 800}]
    r = sz.check_flat_line('LIT1_1', spec, {}, True, files, tmp_path / '_out', 0.2, fake_tools, sys.executable, tmp_path / 'tmp')
    assert r.verdict == 'ERROR' and 'thiếu vùng in BACK' in r.reason
