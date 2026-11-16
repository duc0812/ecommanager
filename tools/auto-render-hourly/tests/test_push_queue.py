import json
import shutil
import sqlite3
import uuid
from pathlib import Path

import pytest
from PIL import Image

import auto_render as ar
from conftest import gradient

TOKEN = 'dwt_secret_test_token'
PROD_URL = 'https://ecom.example.test'
GOOD, WIDE = (210, 110, 390, 150), (210, 110, 420, 150)
BOX_REASON = 'tên vượt khung 15 px (Print · Custom Name)'


@pytest.fixture(autouse=True)
def _own_mutex(monkeypatch):
    real = ar.acquire_mutex
    name = r'Local\EcomManagerAutoRenderHourlyQueueTest-' + uuid.uuid4().hex
    monkeypatch.setattr(ar, 'acquire_mutex', lambda *a, **k: real(name))


@pytest.fixture
def prod_env(tmp_path, monkeypatch):
    profile = tmp_path / 'profile'
    monkeypatch.setenv('USERPROFILE', str(profile))
    p = profile / '.artwork-worker' / 'prod.env'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f'ECOM_URL={PROD_URL}\nDESIGN_WORKER_TOKEN={TOKEN}\n', encoding='utf-8')
    return p


@pytest.fixture
def queue_root(tmp_path, monkeypatch):
    root = tmp_path / 'review-queue'
    monkeypatch.setenv('REVIEW_QUEUE_ROOT', str(root))
    return root


def make_queue_db(root: Path, items: list[tuple]):
    """queue.db as the store writes it (WAL, closed): items (id, status, keys[, updatedAt[, v2 files[, v1 files]]]) with their member keys."""
    root.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(root / 'queue.db')
    c.execute('PRAGMA journal_mode = WAL')
    c.executescript('''
      CREATE TABLE items (id TEXT PRIMARY KEY, taskKey TEXT NOT NULL, groupKey TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        statusReason TEXT, prevStatus TEXT, version INTEGER NOT NULL, enteredAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        apiLines TEXT NOT NULL, meta TEXT, qa TEXT NOT NULL);
      CREATE TABLE versions (itemId TEXT NOT NULL, n INTEGER NOT NULL, files TEXT NOT NULL, apiLines TEXT NOT NULL, qa TEXT NOT NULL,
        createdAt TEXT NOT NULL, PRIMARY KEY (itemId, n));
      CREATE TABLE item_keys (itemId TEXT NOT NULL, taskKey TEXT NOT NULL, PRIMARY KEY (itemId, taskKey));''')
    for item in items:
        item_id, status, keys = item[:3]
        at = item[3] if len(item) > 3 else 't'
        files = item[4] if len(item) > 4 else []
        c.execute("INSERT INTO items VALUES (?, ?, ?, 'line', ?, NULL, NULL, 2, 't', 't', ?, '[]', '{}', '{}')", (item_id, keys[0], keys[0], status, at))
        first = item[5] if len(item) > 5 else []
        c.execute("INSERT INTO versions VALUES (?, 1, ?, '[]', '{}', 't')", (item_id, json.dumps(first)))
        c.execute("INSERT INTO versions VALUES (?, 2, ?, '[]', '{}', 't')", (item_id, json.dumps(files)))
        for k in keys:
            c.execute('INSERT INTO item_keys VALUES (?, ?)', (item_id, k))
    c.commit()
    c.close()


def _render_sha(w, key):
    import hashlib
    return hashlib.sha256((ar.storage_root(ar.load_config(w.config)) / 'design' / key / 'Print' / 'v1.png').read_bytes()).hexdigest()


def _vfile(key, sha, kind='PRINT'):
    return {'part': f'{kind}_Print', 'kind': kind, 'printArea': 'Print', 'taskKey': key, 'sha256': sha}


def _queue_world(world, prod_env, queue_root, **kw):
    return world(extra={'PUSH_VIA': 'queue'}, **kw)


def _push_calls(w):
    return [c for c in w.node.calls() if 'push-' in c['script']]


def _queue_calls(w):
    p = w.node.dir / 'queue-calls.jsonl'
    return [json.loads(l) for l in p.read_text(encoding='utf-8').splitlines() if l.strip()] if p.exists() else []


# ---------------------------------------------------------------- config

def test_queue_mode_needs_the_api_token_and_finds_the_queue_root(cfg_file, prod_env, monkeypatch, tmp_path):
    monkeypatch.delenv('REVIEW_QUEUE_ROOT', raising=False)
    cfg = ar.load_config(cfg_file(PUSH_VIA='queue'))
    assert (cfg.push_via, cfg.worker_token, cfg.ecom_url) == ('queue', TOKEN, PROD_URL)
    assert cfg.review_queue_root == Path(r'D:\Ecom manager\review-queue')
    assert ar.load_config(cfg_file(PUSH_VIA='queue', REVIEW_QUEUE_ROOT=str(tmp_path / 'q1'))).review_queue_root == tmp_path / 'q1'
    monkeypatch.setenv('REVIEW_QUEUE_ROOT', str(tmp_path / 'q2'))
    assert ar.load_config(cfg_file(PUSH_VIA='queue', REVIEW_QUEUE_ROOT=str(tmp_path / 'q1'))).review_queue_root == tmp_path / 'q2'
    prod_env.unlink()
    with pytest.raises(ar.ConfigError, match='PUSH_VIA=queue cần ECOM_URL và DESIGN_WORKER_TOKEN'):
        ar.load_config(cfg_file(PUSH_VIA='queue'))


# ---------------------------------------------------------------- the run

def test_queue_mode_sends_passing_and_failing_lines_to_the_queue_and_never_to_hold(world, prod_env, queue_root, monkeypatch):
    w = _queue_world(world, prod_env, queue_root, hold=True,
                     lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT3_1', readiness='AUTO', ink=WIDE),
                            dict(key='LIT2_1', readiness='LOW', ink=GOOD)],
                     flat=[dict(key='LIT7_1', readiness='AUTO', values={'Custom Name': 'Anna'})])

    def no_lock(*a, **k):
        raise AssertionError('PushLock taken in queue mode')
    monkeypatch.setattr(ar, 'PushLock', no_lock)
    holds = w.home / 'holds.json'                                                   # /hold memory of an earlier api run stays as it was
    holds.parent.mkdir(parents=True, exist_ok=True)
    holds.write_text(json.dumps({'LIT9_1': {'sig': 'x', 'reportedAt': 't', 'jobId': None}}), encoding='utf-8')
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert s['pushed'] == [] and s['held'] == [] and s['errors'] == [] and w.agent.holds == []
    assert json.loads(holds.read_text(encoding='utf-8')) == {'LIT9_1': {'sig': 'x', 'reportedAt': 't', 'jobId': None}}
    assert [(q['taskKey'], q['verdict'], q['items'], q['state']) for q in s['queued']] == [
        ('LIT1_1', 'pass', [], 'vào hàng chờ'), ('LIT3_1', 'fail', [BOX_REASON], 'vào hàng chờ'), ('LIT7_1', 'pass', [], 'vào hàng chờ')]
    local = [c for c in _push_calls(w) if c['script'].endswith('push-local-renders.mjs')]
    assert [c['args'][c['args'].index('--line') + 1] for c in local] == ['LIT1_1', 'LIT3_1']   # LIT2_1 is not AUTO
    for c in local:
        a = c['args']
        assert a[-3:] == ['--via', 'api', '--to-queue'] and '--qa-json' in a and not any(st in a for st in ar.STAGES)
    calls = {c['keys'][0]: c for c in _queue_calls(w)}
    assert set(calls) == {'LIT1_1', 'LIT3_1', 'LIT7_1'}
    assert all(c['root'] == str(queue_root) and c['token'] == TOKEN for c in calls.values())
    q1, q3, q7 = calls['LIT1_1']['qa']['LIT1_1'], calls['LIT3_1']['qa']['LIT3_1'], calls['LIT7_1']['qa']['LIT7_1']
    assert (q1['verdict'], q1['items'], q1['inputs']['source']) == ('pass', [], 'local-render')
    assert (q3['verdict'], q3['items']) == ('fail', [BOX_REASON])
    assert q3['inputs']['pieces'][0]['part'] == 'PRINT_Print' and q3['inputs']['pieces'][0]['fields'][0]['field'] == 'Custom Name'
    assert (q7['verdict'], q7['inputs']['source'], q7['inputs']['values']) == ('pass', 'flat-text', {'Custom Name': 'Anna'})
    assert set(calls['LIT1_1']['qa']) == {'LIT1_1'}                                   # each call gets only its own lines
    assert not list((w.home / 'tmp' / 'queue-qa').glob('*.json'))                     # the --qa-json file is removed
    assert 'LIT3_1 vào hàng chờ local' in w.log() and TOKEN not in w.log()


def test_guard_error_lines_go_to_the_queue_as_qa_failures_not_run_errors(world, prod_env, queue_root):
    reason = 'không xác định được spec flat-text (0 spec khớp)'
    w = world(flat=[dict(key='LIT5_1', readiness='AUTO', sku='ZZ9-M', values={'Custom Name': 'Anna'})])
    assert ar.main(['--config', str(w.config)]) == 1 and w.summary()['errors'][0]['message'] == reason    # ssh: a run error, as today
    w = _queue_world(world, prod_env, queue_root, flat=[dict(key='LIT5_1', readiness='AUTO', sku='ZZ9-M', values={'Custom Name': 'Anna'})])
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert s['errors'] == [] and [(q['taskKey'], q['verdict'], q['items']) for q in s['queued']] == [('LIT5_1', 'fail', [reason])]
    assert _queue_calls(w)[0]['qa']['LIT5_1']['inputs'] == {'source': 'flat-text', 'taskKey': 'LIT5_1', 'error': reason}


def test_queued_keys_are_skipped_before_the_guard(world, prod_env, queue_root):
    make_queue_db(queue_root, [('rq_a1', 'rejected', ['LIT1_1']), ('rq_b2', 'approved', ['LIT4_1']), ('rq_c3', 'qa_failed', ['LIT6_1', 'LIT3_1'])])
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT3_1', readiness='AUTO', ink=WIDE),
                                                         dict(key='LIT4_1', readiness='AUTO', ink=GOOD)])
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert [q['taskKey'] for q in s['queued']] == ['LIT4_1'] and 'LIT1_1' not in s['rendered']
    assert {'taskKey': 'LIT1_1', 'reason': 'đã có trong hàng chờ local (rq_a1, rejected)'} in s['skipped']
    assert {'taskKey': 'LIT3_1', 'reason': 'đã có trong hàng chờ local (rq_c3, qa_failed)'} in s['skipped']
    assert [c['keys'] for c in _queue_calls(w)] == [['LIT4_1']]


def test_held_and_removed_lines_with_the_same_render_are_not_queued_again(world, prod_env, queue_root):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT3_1', readiness='AUTO', ink=WIDE)])
    s1, s3 = _render_sha(w, 'LIT1_1'), _render_sha(w, 'LIT3_1')
    make_queue_db(queue_root, [('rq_h1', 'held', ['LIT1_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT1_1', s1), _vfile('LIT1_1', 'mock', 'MOCKUP')]),
                               ('rq_r3', 'removed', ['LIT3_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT3_1', s3)])])
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert s['queued'] == [] and _queue_calls(w) == [] and w.agent.holds == []
    assert {'taskKey': 'LIT1_1', 'reason': 'hàng chờ local đã giữ lại (rq_h1, held), file render không đổi'} in s['skipped']
    assert {'taskKey': 'LIT3_1', 'reason': 'hàng chờ local đã bỏ (rq_r3, removed), file render không đổi'} in s['skipped']


def test_a_parked_agent_fix_does_not_bring_back_the_original_render(world, prod_env, queue_root):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT3_1', readiness='AUTO', ink=GOOD)])
    s1, s3 = _render_sha(w, 'LIT1_1'), _render_sha(w, 'LIT3_1')
    make_queue_db(queue_root, [('rq_h1', 'held', ['LIT1_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT1_1', 'agent-fix')], [_vfile('LIT1_1', s1)]),
                               ('rq_r3', 'removed', ['LIT3_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT3_1', 'agent-fix')], [_vfile('LIT3_1', s3)])])
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert s['queued'] == [] and _queue_calls(w) == []
    assert {'taskKey': 'LIT1_1', 'reason': 'hàng chờ local đã giữ lại (rq_h1, held), file render không đổi'} in s['skipped']
    assert {'taskKey': 'LIT3_1', 'reason': 'hàng chờ local đã bỏ (rq_r3, removed), file render không đổi'} in s['skipped']


def test_a_held_line_with_a_new_render_is_queued_again(world, prod_env, queue_root):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD)],
                     flat=[dict(key='LIT7_1', readiness='AUTO', values={'Custom Name': 'Anna'})])
    make_queue_db(queue_root, [('rq_h1', 'held', ['LIT1_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT1_1', 'old-sha')]),
                               ('rq_h7', 'removed', ['LIT7_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT7_1', 'old-sha')])])
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert [(q['taskKey'], q['state']) for q in s['queued']] == [('LIT1_1', 'vào hàng chờ'), ('LIT7_1', 'vào hàng chờ')]
    assert 'LIT1_1: file render khác bản cuối của rq_h1 (held)' in w.log()


def test_the_newest_item_of_a_key_decides_and_an_active_one_always_wins(world, prod_env, queue_root):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT3_1', readiness='AUTO', ink=GOOD)])
    s1, s3 = _render_sha(w, 'LIT1_1'), _render_sha(w, 'LIT3_1')
    make_queue_db(queue_root, [('rq_h1', 'held', ['LIT1_1'], '2026-11-15T10:00:00.000Z', [_vfile('LIT1_1', s1)]),
                               ('rq_c1', 'cloud', ['LIT1_1'], '2026-11-15T11:00:00.000Z', [_vfile('LIT1_1', s1)]),
                               ('rq_w3', 'waiting', ['LIT3_1'], '2026-11-15T09:00:00.000Z', [_vfile('LIT3_1', 'other')]),
                               ('rq_h3', 'held', ['LIT3_1', 'LIT9_1'], '2026-11-15T12:00:00.000Z', [_vfile('LIT3_1', s3)])])
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert [q['taskKey'] for q in s['queued']] == ['LIT1_1']
    assert {'taskKey': 'LIT3_1', 'reason': 'đã có trong hàng chờ local (rq_w3, waiting)'} in s['skipped']


def test_no_queue_db_means_nothing_is_queued_yet(world, prod_env, queue_root):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD)])
    assert ar.main(['--config', str(w.config)]) == 0
    assert [q['taskKey'] for q in w.summary()['queued']] == ['LIT1_1'] and not queue_root.exists()


def test_unreadable_queue_db_stops_the_run_before_anything_is_sent(world, prod_env, queue_root):
    queue_root.mkdir(parents=True)
    (queue_root / 'queue.db').write_bytes(b'not a database at all' * 100)
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD)])
    assert ar.main(['--config', str(w.config)]) == 1
    s = w.summary()
    assert s['errors'][0]['stage'] == 'queue' and 'không đọc được hàng chờ local' in s['errors'][0]['message'] and _push_calls(w) == []


@pytest.mark.parametrize('said, expect', [
    ('unchanged', ('queued', 'không đổi (đã có trong hàng chờ)')),
    ('fixing', ('queued', 'không đổi (agent đang sửa)')),
    ('bypassed', ('pushed', None)),
    ('refused', ('skipped', 'không vào hàng chờ: đã có trong hàng chờ rq_other')),
    ('waiting', ('skipped', 'chờ: dòng đầu chưa có trên Drive')),
])
def test_queue_cli_outcomes_are_read_per_key(world, prod_env, queue_root, said, expect):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT4_1', readiness='AUTO', ink=GOOD)])
    w.node.plan(**{**json.loads((w.node.dir / 'plan.json').read_text(encoding='utf-8')), 'queue': {'LIT1_1': said}})
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    kind, text = expect
    assert 'LIT4_1' in [q['taskKey'] for q in s['queued']] and s['errors'] == []
    if kind == 'queued':
        assert next(q for q in s['queued'] if q['taskKey'] == 'LIT1_1')['state'] == text
    elif kind == 'pushed':
        assert s['pushed'] == ['LIT1_1']
    else:
        assert {'taskKey': 'LIT1_1', 'reason': text} in s['skipped'] and 'LIT1_1' not in [q['taskKey'] for q in s['queued']]


@pytest.mark.parametrize('said, text', [('crash', 'push-local-renders --via api --to-queue thoát mã 1'),
                                        ('missing', 'không thấy dòng trong kết quả hàng chờ')])
def test_queue_cli_hard_failures_stop_the_push(world, prod_env, queue_root, said, text):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD), dict(key='LIT4_1', readiness='AUTO', ink=GOOD)])
    w.node.plan(**{**json.loads((w.node.dir / 'plan.json').read_text(encoding='utf-8')), 'queue': {'LIT1_1': said}})
    assert ar.main(['--config', str(w.config)]) == 1
    s = w.summary()
    assert s['errors'][0]['stage'] == 'push' and s['errors'][0]['taskKey'] == 'LIT1_1' and text in s['errors'][0]['message']
    assert [c['keys'] for c in _queue_calls(w)] == [['LIT1_1']]                       # the phase stopped: LIT4_1 never sent


def test_queue_dry_run_sends_nothing(world, prod_env, queue_root):
    w = _queue_world(world, prod_env, queue_root, lines=[dict(key='LIT3_1', readiness='AUTO', ink=WIDE)], hold=True)
    assert ar.main(['--config', str(w.config), '--dry-run']) == 0
    assert _push_calls(w) == [] and w.agent.holds == [] and w.summary()['queued'] == []
    assert 'sẽ đưa vào hàng chờ: LIT3_1' in w.log()


def test_api_and_ssh_modes_never_touch_the_queue(world, prod_env, queue_root):
    for extra in ({'PUSH_VIA': 'api'}, {}):
        w = world(extra=extra, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD)])
        assert ar.main(['--config', str(w.config)]) == 0
        s = w.summary()
        assert s['pushed'] == ['LIT1_1'] and 'queued' not in s and _queue_calls(w) == []
        assert not any('--to-queue' in c['args'] or '--qa-json' in c['args'] for c in _push_calls(w))


# ---------------------------------------------------------------- --qa-item

def _run_queue_and_inputs(world, prod_env, queue_root, **kw):
    w = _queue_world(world, prod_env, queue_root, **kw)
    assert ar.main(['--config', str(w.config)]) == 0
    qa = {k: v for c in _queue_calls(w) for k, v in (c['qa'] or {}).items()}
    return w, qa


def _qa_item(tmp_path, capsys, vdir, inputs) -> tuple[int, dict | None]:
    f = tmp_path / f'qa-inputs-{uuid.uuid4().hex}.json'
    f.write_text(json.dumps(inputs), encoding='utf-8')
    capsys.readouterr()
    code = ar.main(['--qa-item', str(vdir), '--qa-inputs', str(f)])
    out = capsys.readouterr().out.strip()
    return code, (json.loads(out.splitlines()[-1]) if code == 0 else None)


def _version(tmp_path, name, files: dict[str, Path]) -> Path:
    d = tmp_path / name
    (d / 'preview').mkdir(parents=True)
    for part, src in files.items():
        shutil.copyfile(src, d / part)
    return d


def test_qa_item_reruns_the_worker_guard_on_a_version_folder(world, prod_env, queue_root, tmp_path, capsys):
    w, qa = _run_queue_and_inputs(world, prod_env, queue_root, lines=[dict(key='LIT1_1', readiness='AUTO', ink=GOOD),
                                                                       dict(key='LIT3_1', readiness='AUTO', ink=WIDE)])
    storage = Path(qa['LIT1_1']['inputs']['pieces'][0]['basePath']).parents[2]
    good, wide = storage / 'design' / 'LIT1_1' / 'Print' / 'v1.png', storage / 'design' / 'LIT3_1' / 'Print' / 'v1.png'
    logs_before = sorted((w.home / 'logs').glob('*'))
    assert _qa_item(tmp_path, capsys, _version(tmp_path, 'v1', {'PRINT_Print.png': good}), qa['LIT1_1']['inputs']) == (0, {'verdict': 'pass', 'items': []})
    assert _qa_item(tmp_path, capsys, _version(tmp_path, 'v2', {'PRINT_Print.png': wide}), qa['LIT3_1']['inputs']) == (0, {'verdict': 'fail', 'items': [BOX_REASON]})
    assert _qa_item(tmp_path, capsys, _version(tmp_path, 'v3', {'PRINT_Print.png': good}), qa['LIT3_1']['inputs']) == (0, {'verdict': 'pass', 'items': []})
    code, r = _qa_item(tmp_path, capsys, _version(tmp_path, 'v4', {'MOCKUP_Print.jpg': good}), qa['LIT1_1']['inputs'])
    assert code == 0 and r['verdict'] == 'fail' and 'không thấy file PRINT_Print' in r['items'][0]
    assert sorted((w.home / 'logs').glob('*')) == logs_before                       # no run log, no summary, no mutex


def test_qa_item_reruns_the_flat_text_guard(world, prod_env, queue_root, tmp_path, capsys):
    w, qa = _run_queue_and_inputs(world, prod_env, queue_root, flat=[dict(key='LIT7_1', readiness='AUTO', values={'Custom Name': 'Anna'})])
    rendered = w.artwork_builder / 'flat-text' / '_out' / 'LIT7_1' / 'LIT7_1 - FRONT.png'
    assert _qa_item(tmp_path, capsys, _version(tmp_path, 'v1', {'PRINT_FRONT.png': rendered}), qa['LIT7_1']['inputs']) == (0, {'verdict': 'pass', 'items': []})
    small = tmp_path / 'small.png'
    gradient(500, 400).save(small)
    code, r = _qa_item(tmp_path, capsys, _version(tmp_path, 'v2', {'PRINT_FRONT.png': small}), qa['LIT7_1']['inputs'])
    assert (code, r) == (0, {'verdict': 'fail', 'items': ['spec flat-text không khớp khổ file']})


def test_qa_item_saved_error_and_group_inputs(tmp_path, capsys):
    d = _version(tmp_path, 'v1', {})
    assert _qa_item(tmp_path, capsys, d, {'source': 'flat-text', 'taskKey': 'LIT9_1', 'error': 'không xác định được spec flat-text (0 spec khớp)'}) == \
        (0, {'verdict': 'fail', 'items': ['không xác định được spec flat-text (0 spec khớp)']})
    assert _qa_item(tmp_path, capsys, d, {'source': 'reuse', 'taskKey': 'LIT9_1'}) == (0, {'verdict': 'unchecked', 'items': []})
    group = {'byKey': {'LIT9_1': {'source': 'reuse', 'taskKey': 'LIT9_1'}, 'LIT9_2': {'source': 'flat-text', 'taskKey': 'LIT9_2', 'error': 'hỏng'}}}
    assert _qa_item(tmp_path, capsys, d, group) == (0, {'verdict': 'fail', 'items': ['LIT9_2: hỏng']})


def test_qa_item_bad_input_exits_2(tmp_path, capsys):
    d = _version(tmp_path, 'v1', {})
    f = tmp_path / 'bad.json'
    f.write_text('{not json', encoding='utf-8')
    assert ar.main(['--qa-item', str(d), '--qa-inputs', str(f)]) == 2
    assert ar.main(['--qa-item', str(tmp_path / 'nope'), '--qa-inputs', str(f)]) == 2
    assert ar.main(['--qa-item', str(d)]) == 2
    f.write_text('[1, 2]', encoding='utf-8')
    assert ar.main(['--qa-item', str(d), '--qa-inputs', str(f)]) == 2
    assert capsys.readouterr().out == ''


# ---------------------------------------------------------------- live-safety fixes

def test_a_type_error_while_building_inputs_never_breaks_an_ssh_run(cfg, make_dbs, tmp_path, monkeypatch):
    from datetime import datetime
    real = ar.worker_inputs

    def bad_area(*a, **k):
        i = real(*a, **k)
        return {**i, 'area': (0.0, None, 600.0, 400.0)}
    monkeypatch.setattr(ar, 'worker_inputs', bad_area)
    pr = make_dbs(tmp_path, [dict(key='LIT1_1', readiness='AUTO', ink=GOOD)])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', ar.RunLog(tmp_path / 'home', datetime.now()))
    line = next(l for l in plan.lines if l.key == 'LIT1_1')
    assert line.result.verdict == 'ERROR' and 'TypeError' in line.result.reason and plan.push_local == []
    assert line.inputs == {'source': 'local-render', 'taskKey': 'LIT1_1', 'error': line.result.reason}
    assert plan.errors == [{'stage': 'guard', 'taskKey': 'LIT1_1', 'message': line.result.reason}]


class _LockedConn:
    def __init__(self, errors):
        self.errors = errors

    def execute(self, *a):
        if self.errors:
            raise self.errors.pop(0)
        return self

    def fetchall(self):
        return [('LIT1_1', 'rq_a1', 'waiting')]

    def close(self):
        pass


@pytest.mark.parametrize('errors, slept, ok', [
    (['database is locked', 'database is busy'], [1, 1], True),
    (['database is locked'] * 4, [1, 1, 1], False),
    (['no such table: item_keys'], [], False),
])
def test_queued_keys_retries_a_locked_or_busy_queue_db(tmp_path, monkeypatch, errors, slept, ok):
    (tmp_path / 'queue.db').write_bytes(b'')
    conn = _LockedConn([sqlite3.OperationalError(e) for e in errors])
    monkeypatch.setattr(ar, '_ro', lambda db: conn)
    naps = []
    if ok:
        assert ar.queued_keys(tmp_path, sleep=naps.append) == {'LIT1_1': {'itemId': 'rq_a1', 'status': 'waiting'}}
    else:
        with pytest.raises(ar.StageError) as e:
            ar.queued_keys(tmp_path, sleep=naps.append)
        assert e.value.stage == 'queue' and errors[-1] in e.value.message
    assert naps == slept
