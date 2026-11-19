import os
import sqlite3
import threading
import time

import pytest

import agent_api
import runner
import work_board
from conftest import calls, make_queue, queue_item, wait_until

T0 = '2026-11-19T11:03:20.150Z'
T1 = '2026-11-19T12:30:00.000Z'
T2 = '2026-11-19T13:45:10.000Z'
NOW = 1_800_000_000.0
HOUR = 3600

README = """# 6 luồng design task

| Luồng | File | Dòng cần làm | Chip trên tool |
|---|---|---|---|
| 1 | auto-not-render.md | 13 | Auto - Not Render |
| 2 | can-chinh.md | 29 | Cần chỉnh (LOW) |
| 3 | `lam-tay.md` | 34 | Làm tay |

## Luồng 7 — Đơn bị trả lại (chủ shop yêu cầu 11/19)
Từ 11/19 09:15 mọi dòng REJECTED trên prod thuộc **luồng 7** (`tra-lai.md`, phiên `luong7-tra-lai`), kể cả dòng từng thuộc luồng khác.

## Quy tắc
10. Cần đổi luồng: ghi một dòng vào `handoff.md` (`KEY | từ luồng | sang luồng | lý do | giờ`).
"""

LIST_HEAD = "# danh sách\n\n| key | status | placed | design |\n|---|---|---|---|\n"


def rows(*keys):
    return LIST_HEAD + ''.join(f'| {k} | NEW/AUTO | 2026-11-17 | TN0709261453 |\n' for k in keys)


def streams(tmp_path, name='_streams-1118', readme=README, age_h=1, **files):
    """A stream folder under a builder dir with spaces; every file is `age_h` hours old unless given as (text, hours)."""
    folder = tmp_path / 'artwork builder' / name
    folder.mkdir(parents=True, exist_ok=True)
    files = {'README.md': readme, **{k.replace('__', '-').replace('_md', '.md'): v for k, v in files.items()}}
    for fname, value in files.items():
        text, hours = value if isinstance(value, tuple) else (value, age_h)
        (folder / fname).write_text(text, encoding='utf-8')
        os.utime(folder / fname, (NOW - hours * HOUR, NOW - hours * HOUR))
    return folder.parent


def by_key(entries):
    return {e['taskKey']: e for e in entries}


def log_text():
    return ''.join(p.read_text(encoding='utf-8') for p in (agent_api.home() / 'logs').glob('runner-*.log'))


def test_every_key_of_a_group_item_is_listed(tmp_path):                           # Review Focus 2
    db = make_queue(tmp_path / 'queue.db', ('rq_g', ['REMI1084_1', 'REMI1158_1', 'REMI1166_1'], 'waiting', T0),
                    ('rq_l', ['LIT7291_1'], 'fixing', T0))
    got = by_key(work_board.queue_entries(db))
    assert sorted(got) == ['LIT7291_1', 'REMI1084_1', 'REMI1158_1', 'REMI1166_1']
    assert all(e['source'] == 'LOCAL_QUEUE' and e['worker'] == 'Hàng duyệt local' for e in got.values())
    assert {got[k]['state'] for k in ('REMI1084_1', 'REMI1158_1', 'REMI1166_1')} == {'waiting'}
    assert work_board.local_queue_holder(db, 'REMI1166_1')['state'] == 'waiting'  # a key that is not the lead key


def test_newest_item_wins(tmp_path):
    db = make_queue(tmp_path / 'queue.db', ('rq_new', ['LIT6242_1'], 'waiting', T2, None, 2),
                    ('rq_old', ['LIT6242_1'], 'rejected', T0, 'Sai màu'), ('rq_mid', ['LIT6242_1'], 'needs_look', T1, 'Prod đã đổi'))
    got = work_board.queue_entries(db)
    assert len(got) == 1 and got[0]['state'] == 'waiting' and got[0]['version'] == 2 and 'detail' not in got[0]


def test_cloud_item_clears_the_key(tmp_path):
    db = make_queue(tmp_path / 'queue.db', ('rq_old', ['LIT6242_1', 'LIT6243_1'], 'held', T0, 'Thiếu mockup'),
                    ('rq_c', ['LIT6242_1'], 'cloud', T1), ('rq_a', ['LIT7000_1'], 'rejected', T0),
                    ('rq_b', ['LIT7000_1'], 'approved', T1), ('rq_d', ['LIT7001_1'], 'qa_failed', T0),
                    ('rq_e', ['LIT7001_1'], 'removed', T1))
    assert sorted(by_key(work_board.queue_entries(db))) == ['LIT6243_1']          # the group's other key has no newer item
    assert work_board.local_queue_holder(db, 'LIT6242_1') is None


def test_eta_is_entered_at_plus_one_hour(tmp_path):
    db = make_queue(tmp_path / 'queue.db', ('rq_w', ['LIT1_1'], 'waiting', T0), ('rq_q', ['LIT2_1'], 'qa_failed', T1),
                    ('rq_n', ['LIT3_1'], 'needs_look', T0), ('rq_f', ['LIT4_1'], 'fixing', T0),
                    ('rq_r', ['LIT5_1'], 'rejected', T0), ('rq_h', ['LIT6_1'], 'held', T0))
    got = by_key(work_board.queue_entries(db))
    assert got['LIT1_1']['etaAt'] == '2026-11-19T12:03:20.150Z' and got['LIT2_1']['etaAt'] == '2026-11-19T13:30:00.000Z'
    assert all('etaAt' not in got[k] for k in ('LIT3_1', 'LIT4_1', 'LIT5_1', 'LIT6_1'))
    assert by_key(work_board.queue_entries(db, countdown_s=3 * HOUR))['LIT1_1']['etaAt'] == '2026-11-19T14:03:20.150Z'


def test_database_is_opened_read_only(tmp_path, monkeypatch):
    db = make_queue(tmp_path / 'queue.db', ('rq_w', ['LIT1_1'], 'waiting', T0))
    before, seen, real = db.read_bytes(), [], sqlite3.connect

    def spy(target, *a, **kw):
        seen.append((target, kw.get('uri')))
        conn = real(target, *a, **kw)
        with pytest.raises(sqlite3.OperationalError): conn.execute("UPDATE items SET status = 'cloud'")
        return conn
    monkeypatch.setattr(work_board.sqlite3, 'connect', spy)
    assert len(work_board.queue_entries(db)) == 1 and work_board.local_queue_holder(db, 'LIT1_1')
    assert seen and all(t == db.as_uri() + '?mode=ro' and uri is True for t, uri in seen)
    assert db.read_bytes() == before and sorted(p.name for p in tmp_path.iterdir()) == ['home', 'queue.db']
    with pytest.raises(sqlite3.Error): work_board.queue_entries(tmp_path / 'none.db')
    assert not (tmp_path / 'none.db').exists()                                    # a read-only open never creates the file


def test_path_with_spaces_works(tmp_path):
    db = make_queue(tmp_path / 'Ecom manager' / 'review queue #1' / 'queue.db', ('rq_w', ['LIT1_1'], 'waiting', T0))
    assert [e['taskKey'] for e in work_board.queue_entries(db)] == ['LIT1_1']


def test_strings_are_trimmed_and_detail_is_cut_to_300(tmp_path):
    db = make_queue(tmp_path / 'queue.db', ('rq_a', ['  LIT1_1 '], 'needs_look', T0, '  ' + 'ă' * 400 + '  '),
                    ('rq_b', ['LIT2_1'], 'qa_failed', T0, None, 3, {'verdict': 'fail', 'items': [' tên vượt khung 18 px ', 'Thiếu mockup', 7]}),
                    ('rq_c', ['LIT3_1'], 'rejected', T0, '   '), ('rq_d', ['LIT4_1'], 'fixing', T0, None, 1, 'not json {'),
                    ('rq_e', ['   '], 'waiting', T0))
    got = by_key(work_board.queue_entries(db))
    assert sorted(got) == ['LIT1_1', 'LIT2_1', 'LIT3_1', 'LIT4_1']
    assert got['LIT1_1']['detail'] == 'ă' * 300
    assert got['LIT2_1']['detail'] == 'tên vượt khung 18 px; Thiếu mockup' and got['LIT2_1']['version'] == 3
    assert 'detail' not in got['LIT3_1'] and 'detail' not in got['LIT4_1']


def test_stream_rows_parsed_from_markdown(tmp_path):
    builder = streams(tmp_path, auto__not__render_md=rows('LIT6691_1', 'LIT7034_2') + '| LIT99 | x |\n| key2 | y |\n|  | z |\n',
                      can__chinh_md=rows('LIT6262_1', 'REMI1017_3'), lam__tay_md='KEY | lý do\n---|---\nLIT6900_1 | túi\n',
                      hoi__khach_md=rows('LIT5000_1'), tra__lai_md=rows('LIT6242_1'), progress__luong7_md='x')
    entries, owner = work_board.stream_entries(builder, NOW)
    got = by_key(entries)
    assert sorted(got) == ['LIT6242_1', 'LIT6262_1', 'LIT6691_1', 'LIT6900_1', 'LIT7034_2', 'REMI1017_3']
    assert got['LIT6691_1'] == {'taskKey': 'LIT6691_1', 'source': 'STREAM', 'worker': 'Luồng 1', 'state': 'listed', 'detail': 'auto-not-render.md'}
    assert got['REMI1017_3']['worker'] == 'Luồng 2' and got['LIT6900_1']['worker'] == 'Luồng 3' and got['LIT6242_1']['worker'] == 'Luồng 7'
    assert owner == 'Luồng 7'


def test_newest_stream_folder_is_used_and_none_is_empty(tmp_path):
    assert work_board.stream_entries(tmp_path / 'artwork builder', NOW) == ([], None)
    streams(tmp_path, name='_streams-1117', auto__not__render_md=rows('LIT1_1'))
    builder = streams(tmp_path, name='_streams-1118', auto__not__render_md=rows('LIT2_1'))
    os.utime(builder / '_streams-1117', (NOW - 30 * HOUR, NOW - 30 * HOUR)); os.utime(builder / '_streams-1118', (NOW - HOUR, NOW - HOUR))
    (builder / '_streams-file').write_text('x')
    assert [e['taskKey'] for e in work_board.stream_entries(builder, NOW)[0]] == ['LIT2_1']


def test_handoff_moves_a_key(tmp_path):
    handoff = ('LIT7002_1 | luồng 1 | luồng 2 | AF-TODDLER-3T không có template | 2026-11-18 00:25\n'
               'LIT6900_1 | luồng 3 | luồng 7 | bị trả lại lần nữa | 11/19 09:14\n'
               'LIT8000_1 | luồng 2 | luồng 3 | dòng chưa có trong danh sách nào | 11/19\n'
               'không phải dòng | luồng 1 | luồng 2\nLIT8001_1 | luồng 1 | không rõ | x\n')
    builder = streams(tmp_path, auto__not__render_md=rows('LIT7002_1', 'LIT7003_1'), lam__tay_md=rows('LIT6900_1'),
                      can__chinh_md=rows(), tra__lai_md=rows('LIT6242_1'), handoff_md=handoff)
    got = by_key(work_board.stream_entries(builder, NOW)[0])
    assert {k: e['worker'] for k, e in got.items()} == {
        'LIT7002_1': 'Luồng 2', 'LIT7003_1': 'Luồng 1', 'LIT6900_1': 'Luồng 7', 'LIT6242_1': 'Luồng 7', 'LIT8000_1': 'Luồng 3'}
    assert got['LIT7002_1']['detail'] == 'handoff.md: Luồng 1 → Luồng 2'


def test_recent_progress_file_keeps_an_old_list_valid(tmp_path):
    builder = streams(tmp_path, age_h=72, auto__not__render_md=rows('LIT1_1'), can__chinh_md=rows('LIT2_1'),
                      progress__luong2__B_md=('KEY | ghi chú\n', 47), progress__luong20_md=('x', 1))
    assert {e['taskKey']: e['worker'] for e in work_board.stream_entries(builder, NOW)[0]} == {'LIT2_1': 'Luồng 2'}


def test_stream_past_48_h_is_dropped(tmp_path):
    builder = streams(tmp_path, age_h=49, auto__not__render_md=rows('LIT1_1'), can__chinh_md=(rows('LIT2_1'), 47),
                      tra__lai_md=rows('LIT3_1'), progress__luong1_md=('x', 48.5),
                      handoff_md=('LIT2_1 | luồng 2 | luồng 1 | sang luồng đã hết hạn | 11/19\n', 1))
    entries, owner = work_board.stream_entries(builder, NOW)
    assert entries == [] and owner is None                                        # LIT2_1 went to a stream that is no longer valid
    assert [e['taskKey'] for e in work_board.stream_entries(builder, NOW, ttl_s=50 * HOUR)[0]] == ['LIT1_1', 'LIT2_1', 'LIT3_1']


def test_rejected_owner_read_from_readme(tmp_path):
    builder = streams(tmp_path, tra__lai_md=rows('LIT6242_1'), lam__tay_md=rows('LIT6242_1', 'LIT6900_1'))
    entries, owner = work_board.stream_entries(builder, NOW)
    assert owner == 'Luồng 7' and by_key(entries)['LIT6242_1']['worker'] == 'Luồng 7'   # the REJECTED stream's list wins
    stale = streams(tmp_path / 'b', tra__lai_md=(rows('LIT6242_1'), 60), lam__tay_md=rows('LIT6900_1'))
    assert work_board.stream_entries(stale, NOW)[1] is None
    plain = streams(tmp_path / 'c', readme=README.split('## Luồng 7')[0], lam__tay_md=rows('LIT6900_1'))
    assert work_board.stream_entries(plain, NOW)[1] is None


def test_held_entry_is_published_but_is_not_a_holder(server, deps, tmp_path):
    d = deps(server, 'done')
    queue_item(d.cfg.review_queue_db, 'rq_h', ['LIT7281_1'], 'held', T0, 'Lỗi QA ở hàng chờ local, quá 1 giờ không ai xử lý: Thiếu mockup')
    queue_item(d.cfg.review_queue_db, 'rq_w', ['LIT7291_1', 'LIT7292_1'], 'waiting', T0)
    (d.cfg.artwork_builder / '_streams-1118').mkdir()
    (d.cfg.artwork_builder / '_streams-1118' / 'README.md').write_text(README, encoding='utf-8')
    (d.cfg.artwork_builder / '_streams-1118' / 'tra-lai.md').write_text(rows('LIT6242_1'), encoding='utf-8')
    assert work_board.publish_once(d) is True
    body = calls(server, '/board')[-1]
    assert server.calls[-1][:2] == ('PUT', '/api/design-agent/runner/board') and body['rejectedOwner'] == 'Luồng 7'
    got = {(e['taskKey'], e['source']): e for e in body['entries']}
    assert sorted(got) == [('LIT6242_1', 'STREAM'), ('LIT7281_1', 'LOCAL_QUEUE'), ('LIT7291_1', 'LOCAL_QUEUE'), ('LIT7292_1', 'LOCAL_QUEUE')]
    assert got[('LIT7281_1', 'LOCAL_QUEUE')]['state'] == 'held' and 'Thiếu mockup' in got[('LIT7281_1', 'LOCAL_QUEUE')]['detail']
    assert work_board.local_queue_holder(d.cfg.review_queue_db, 'LIT7281_1') is None
    assert work_board.local_queue_holder(d.cfg.review_queue_db, 'LIT7292_1')['state'] == 'waiting'
    assert work_board.local_queue_holder(d.cfg.review_queue_db, 'LIT9999_1') is None


def test_unreadable_queue_publishes_nothing(server, deps, tmp_path):
    d = deps(server, 'done', REVIEW_QUEUE_DB=str(tmp_path / 'gone' / 'queue.db'))
    state: dict = {}
    assert work_board.publish_once(d, state) is False and work_board.publish_once(d, state) is False
    assert not calls(server, '/board') and log_text().count('không đọc được hàng duyệt local') == 1
    broken = tmp_path / 'broken.db'; broken.write_bytes(b'this is not sqlite' * 100)
    assert work_board.publish_once(deps(server, 'done', REVIEW_QUEUE_DB=str(broken))) is False and not calls(server, '/board')


def test_publish_never_raises_and_reports_a_refusal_once(server, deps):
    d = deps(server, 'done'); state: dict = {}
    server.board_status = 500
    assert work_board.publish_once(d, state) is False and work_board.publish_once(d, state) is False
    assert log_text().count('không đăng được bảng việc') == 1 and server.token not in log_text()
    server.board_status = 200
    assert work_board.publish_once(d, state) is True and 'đăng lại được' in log_text()
    server.status = {'/board': 401}
    assert work_board.publish_once(d, state) is False
    d.api = None
    assert work_board.publish_once(d, state) is False


def test_api_publish_board_and_busy_follow_the_contract(server):
    api = agent_api.AgentApi(server.url, server.token)
    row = {'taskKey': 'LIT1_1', 'source': 'STREAM', 'worker': 'Luồng 7', 'state': 'listed'}
    assert api.publish_board([row], 'Luồng 7') == {'ok': True, 'count': 1}
    assert server.calls[-1] == ('PUT', '/api/design-agent/runner/board', {'entries': [row], 'rejectedOwner': 'Luồng 7'})
    assert api.publish_board([], None) == {'ok': True, 'count': 0} and server.calls[-1][2] == {'entries': [], 'rejectedOwner': None}
    with pytest.raises(agent_api.ApiError) as e: api.publish_board([{'taskKey': 'LIT1_1'}], None)
    assert e.value.status == 400
    assert api.busy('j 1', 'Hàng duyệt local', 'đang chờ duyệt, bản v2') == {'ok': True, 'status': 'CANCELLED'}
    assert server.calls[-1] == ('POST', '/api/design-agent/runner/jobs/j%201/busy', {'worker': 'Hàng duyệt local', 'detail': 'đang chờ duyệt, bản v2'})


def test_serve_publishes_the_board_at_start_and_then_every_interval(server, deps, monkeypatch):
    monkeypatch.setattr(work_board, 'BOARD_PUBLISH_S', 0.3)
    d = deps(server, 'done')
    queue_item(d.cfg.review_queue_db, 'rq_w', ['LIT7291_1'], 'waiting', T0)
    stop = threading.Event(); t = threading.Thread(target=runner.serve, args=(d,), kwargs={'stop': stop}); t.start()
    wait_until(lambda: len(calls(server, '/board')) >= 3); stop.set(); t.join(10)
    assert calls(server, '/board')[0]['entries'][0]['taskKey'] == 'LIT7291_1'
    time.sleep(0.8); n = len(calls(server, '/board')); time.sleep(0.8)
    assert len(calls(server, '/board')) == n                                      # the publisher stops with serve
    assert work_board.BOARD_PUBLISH_S == 0.3 and runner.work_board is work_board


def test_publisher_stops_when_a_once_run_ends(server, deps, monkeypatch):
    monkeypatch.setattr(work_board, 'BOARD_PUBLISH_S', 0.2)
    assert runner.serve(deps(server, 'done'), once=True) == runner.EXIT_OK and calls(server, '/board')
    time.sleep(0.6); n = len(calls(server, '/board')); time.sleep(0.6)
    assert len(calls(server, '/board')) == n


def test_default_interval_and_queue_path(server, env_file):
    assert work_board.BOARD_PUBLISH_S == 120
    cfg = runner.load_config(env_file(server, REVIEW_QUEUE_DB=None))
    assert str(cfg.review_queue_db) == r'D:\Ecom manager\review-queue\queue.db'
    assert str(runner.load_config(env_file(server, REVIEW_QUEUE_DB=r'E:\hàng duyệt\queue.db')).review_queue_db) == r'E:\hàng duyệt\queue.db'


def test_job_on_a_queued_line_calls_busy_and_never_starts(server, deps, job):
    server.jobs = [job(id='j1', key='REMI1158_1'), job(id='j2', key='LIT7_1'), job(id='j3', key='LIT7281_1', kind='MAKE')]
    d = deps(server, 'done')
    queue_item(d.cfg.review_queue_db, 'rq_g', ['REMI1084_1', 'REMI1158_1'], 'qa_failed', T0, '  tên vượt khung 18 px ' + 'x' * 400, 2)
    queue_item(d.cfg.review_queue_db, 'rq_h', ['LIT7281_1'], 'held', T0, 'Thiếu mockup')
    assert runner.serve(d, once=True) == runner.EXIT_OK
    busy = [(p, b) for _, p, b in server.calls if p.endswith('/busy')]
    assert [p for p, _ in busy] == ['/api/design-agent/runner/jobs/j1/busy']
    body = busy[0][1]
    assert body['worker'] == 'Hàng duyệt local' and body['detail'].startswith('lỗi QA, bản v2: tên vượt khung 18 px') and len(body['detail']) <= 300
    assert not any('/jobs/j1/' in p and not p.endswith('/busy') for _, p, _ in server.calls)
    assert not (d.cfg.artwork_builder / 'REMI1158_1-agent-j1').exists()
    assert sorted(p for _, p, _ in server.calls if p.endswith('/result')) == [
        '/api/design-agent/runner/jobs/j2/result', '/api/design-agent/runner/jobs/j3/result']   # free line and held line still run


def test_library_apply_is_not_checked_against_the_queue(server, deps, job, tmp_path):
    server.jobs = [job(id='j1', kind='LIBRARY_APPLY')]
    d = deps(server, 'done', REVIEW_QUEUE_DB=str(tmp_path / 'gone.db'))
    runner.serve(d, once=True)
    assert not calls(server, '/busy') and (d.cfg.artwork_builder / 'LIT6262_1-agent-j1').exists()


def test_unreadable_queue_fails_the_job_without_starting_it(server, deps, job, tmp_path):
    server.jobs = [job(id='j1')]
    d = deps(server, 'done', REVIEW_QUEUE_DB=str(tmp_path / 'gone' / 'queue.db'))
    assert runner.serve(d, once=True) == runner.EXIT_OK
    assert calls(server, '/jobs/j1/fail') == [{'error': 'không đọc được hàng duyệt local', 'permanent': False}]
    assert not calls(server, '/heartbeat') and not calls(server, '/result') and not calls(server, '/busy')
    assert not (d.cfg.artwork_builder / 'LIT6262_1-agent-j1').exists()


def test_busy_that_the_server_refuses_still_does_not_start_the_job(server, deps, job):
    server.jobs = [job(id='j1')]; server.status = {'/jobs/j1/busy': 409}
    d = deps(server, 'done')
    queue_item(d.cfg.review_queue_db, 'rq_w', ['LIT6262_1'], 'waiting', T0)
    assert runner.serve(d, once=True) == runner.EXIT_OK
    assert len(calls(server, '/busy')) == 1 and not calls(server, '/heartbeat') and not calls(server, '/result')
    assert not (d.cfg.artwork_builder / 'LIT6262_1-agent-j1').exists()
