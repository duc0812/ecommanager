import json
from datetime import datetime

import pytest

import auto_render as ar

log = None


@pytest.fixture(autouse=True)
def _log(tmp_path):
    global log
    log = ar.RunLog(tmp_path / 'home', datetime.now())


def keys(plan, verdict): return sorted(l.key for l in plan.lines if l.result.verdict == verdict)


def test_only_passing_auto_lines_are_pushable(cfg, make_dbs, tmp_path):
    pr = make_dbs(tmp_path, [
        dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
        dict(key='LIT2_1', readiness='LOW', ink=(210, 110, 390, 150)),          # renders fine, prod says LOW
        dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150)),         # past its box
        dict(key='LIT4_1', readiness='AUTO', ink=(210, 110, 390, 150), status='REVIEW'),   # already moved on prod
    ])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert plan.push_local == ['LIT1_1'] and keys(plan, 'HOLD') == ['LIT3_1']
    assert 'LIT4_1' not in {l.key for l in plan.lines}
    assert next(l for l in plan.lines if l.key == 'LIT2_1').readiness == 'LOW' and 'LIT2_1' not in plan.pushable


def test_lone_no_on_a_worker_line(cfg, make_dbs, tmp_path):
    no = [('Custom Name: Yes Or No?', 'No'), ('Custom Name', 'KANTORSKI')]
    pr = make_dbs(tmp_path, [dict(key='LIT5_1', readiness='AUTO', pairs=no, ink=(210, 110, 390, 150), fileName='5_1_Print_auto.png'),
                             dict(key='LIT6_1', readiness='AUTO', pairs=no, ink=None, fileName='6_1_Print_auto-noname.png')])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert keys(plan, 'HOLD') == ['LIT5_1'] and plan.push_local == ['LIT6_1']


def test_flat_spec_is_filtered_next_to_the_original(cfg, flat_run, tmp_path):
    pr = flat_run(specs={'TN1-M': dict(design='TN1', supplierSku='M-15')},
                  done=[dict(key='LIT7_1', readiness='AUTO', sku='TN1-M-15X14INCH', supplierSku='M-15', values={'Custom Name': 'Anna'}),
                        dict(key='LIT8_1', readiness='MANUAL', sku='TN1-M-15X14INCH', supplierSku='M-15', values={'Custom Name': 'Bo'})])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert plan.flat_spec.parent == pr.flat_spec.parent and plan.flat_spec.name.endswith('.auto.json')
    assert [g['lines'] for g in json.loads(plan.flat_spec.read_text(encoding='utf-8'))['groups']] == [['LIT7_1']]


def test_unresolved_spec_is_an_error_not_a_push(cfg, flat_run, tmp_path):                  # Review Focus 4
    two = {'TN1-RED': dict(design='TN1'), 'TN1-PINK': dict(design='TN1')}
    pr = flat_run(specs=two, done=[dict(key='LIT9_1', readiness='AUTO', sku='TN1-M', supplierSku='M-15', values={'Custom Name': 'Anna'})])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert plan.flat_spec is None and 'LIT9_1' not in plan.pushable
    assert plan.errors == [{'stage': 'guard', 'taskKey': 'LIT9_1', 'message': 'không xác định được spec flat-text (2 spec khớp)'}]


def test_spec_filter_port(tmp_path, write_spec):
    write_spec('A', design='TN1', supplierSku='WZIP-XL', skuContains='Zip', match={'Choose Color': 'Option 5'})
    write_spec('B', design='TN1', supplierSku='WZIP-XL', skuContains='Zip', match={'Choose Color': 'Option 3'})
    write_spec('C', design='TN1', minOrder=6000, skuNot='Zip')
    prod = dict(sku='TN1-Fleece Zip Hoodie', resolvedSupplierSku='wzip-xl', variantTitle='XL', shopifyProductId='p', storeId='s',
                pairs=[('Choose Color:', 'option 5')])
    assert ar.resolve_flat_spec(tmp_path, 'LIT6100_1', prod).parent.name == 'A'
    assert ar.design_of('upload-BLANK=TN0506261601') == 'TN0506261601' and ar.design_of('TN0506261601-M-15X14INCH') == 'TN0506261601'


def test_reuse_goes_and_cm_builder_does_not(cfg, make_dbs, tmp_path):
    pr = make_dbs(tmp_path, [dict(key='LIT10_1', readiness='AUTO'), dict(key='LIT11_1', readiness='AUTO')],
                  shared={'groups': [{'source': 'LIT1', 'lines': ['LIT10_1'], 'files': [{'printArea': 'Print', 'driveFileId': 'd1'}]},
                                     {'source': 'LIT11_1', 'lines': ['LIT11_1'], 'files': [{'printArea': 'Print', 'path': 'cm/LIT11_1.png'}]}]})
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert [g['lines'] for g in json.loads(plan.shared_spec.read_text(encoding='utf-8'))['groups']] == [['LIT10_1']]
    assert plan.skipped == [{'taskKey': 'LIT11_1', 'reason': 'cm-builder: không thuộc auto render hàng giờ'}]


def test_lone_no_is_checked_even_without_a_library_entry(cfg, make_dbs, tmp_path):   # review fix 1
    no = [('Custom Name: Yes Or No?', 'No'), ('Custom Name', 'KANTORSKI')]
    pr = make_dbs(tmp_path, [dict(key='LIT12_1', readiness='AUTO', pairs=no, ink=(210, 110, 390, 150), fileName='12_1_Print_auto.png', entryId=None),
                             dict(key='LIT13_1', readiness='AUTO', pairs=no, ink=None, fileName='13_1_Print_auto-noname.png', entryId=None)])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    held = next(l for l in plan.lines if l.key == 'LIT12_1').result
    assert (held.verdict, held.guard, held.reason) == ('HOLD', 'NO', 'khách chọn No nhưng file in có tên')
    assert keys(plan, 'UNCHECKED') == ['LIT13_1'] and plan.push_local == ['LIT13_1']
