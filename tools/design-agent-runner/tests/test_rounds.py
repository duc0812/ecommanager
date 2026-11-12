"""The round flow of FIX / MAKE / MOCKUP jobs: maker session, fresh QA session, runner-side delivery."""
import json
import threading

import agent_api
import runner
from conftest import calls, wait_dead

FOLDER = 'LIT6262_1-agent-job1'
PUT = '/tasks/LIT6262_1/artwork'
SUBMIT = '/tasks/LIT6262_1/submit'


def plan(**phases):
    return {'FAKE_CLAUDE_PLAN': json.dumps(phases)}


def jdir(cfg):
    return cfg.artwork_builder / FOLDER


def puts(server):
    return [b['query'] for m, p, b in server.calls if m == 'PUT']


def fake(cfg, phase, n):
    p = jdir(cfg) / f'fake-{phase}-{n}.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else None


def test_pass_on_round_one_uploads_each_file_submits_and_reports_done(server, run, cfg):
    assert run(server, 'done') == 'DONE'
    assert puts(server) == [{'printArea': 'FRONT', 'fileName': 'FRONT.jpg', 'kind': 'PRINT'},
                            {'printArea': 'Preview', 'fileName': 'Preview.png', 'kind': 'MOCKUP'}]
    paths = [p for _, p, _ in server.calls]
    assert paths.index('/api/design-agent/runner' + SUBMIT) > max(i for i, p in enumerate(paths) if p.endswith(PUT))
    assert calls(server, '/jobs/job1/result') == [{
        'outcome': 'DONE', 'summary': 'Vòng 1: dời tên vào trong khung. QA độc lập: đạt cả 8 mục.', 'rounds': 1,
        'result': {'pushed': ['FRONT', 'Preview'], 'qa': 'PASS', 'rounds': 1}}]
    maker, qa = fake(cfg, 'maker', 1), fake(cfg, 'qa', 1)
    assert maker and qa and maker['pid'] != qa['pid'] and not fake(cfg, 'maker', 2)          # QA is a fresh session
    assert maker['env']['DESIGN_AGENT_TOKEN'] is None and qa['env']['DESIGN_AGENT_TOKEN'] is None
    assert maker['argv'][1].startswith('# Design Agent — fix job') and qa['argv'][1].startswith('# Design Agent — QA độc lập')
    d = jdir(cfg)
    assert (d / 'prompt-round-1-maker.md').exists() and (d / 'prompt-round-1-qa.md').exists()
    assert not calls(server, '/fail') and json.loads((d / 'runner-state.json').read_text(encoding='utf-8'))['outcome'] == 'DONE'


def test_maker_and_qa_get_their_own_models(server, run, cfg):
    assert run(server, 'done', CLAUDE_MODEL='maker-model', CLAUDE_QA_MODEL='qa-model') == 'DONE'
    assert fake(cfg, 'maker', 1)['argv'][-2:] == ['--model', 'maker-model'] and fake(cfg, 'qa', 1)['argv'][-2:] == ['--model', 'qa-model']
    for phase in ('maker', 'qa'):
        argv = fake(cfg, phase, 1)['argv']; deny = argv[argv.index('--disallowedTools') + 1:argv.index('--add-dir')]
        assert list(deny) == list(runner.DEFAULT_DISALLOWED)


def test_fail_then_pass_runs_a_second_round_from_the_qa_result(server, run, cfg):
    assert run(server, 'done', env=plan(qa=['fail', 'pass'])) == 'DONE'
    d = jdir(cfg)
    one, two = (d / 'prompt-round-1-maker.md').read_text(encoding='utf-8'), (d / 'prompt-round-2-maker.md').read_text(encoding='utf-8')
    assert 'QA-claude/round-1-result.json' not in one
    assert f'{d.as_posix()}/QA-claude/round-1-result.json' in two and 'round-1/deliver/' in two and 'chỉ sửa các mảnh có trong `findings`' in two
    assert 'QA-claude/round-1-result.json' in (d / 'prompt-round-2-qa.md').read_text(encoding='utf-8')
    assert len(puts(server)) == 2 and len(calls(server, SUBMIT)) == 1                         # only the passing round is delivered
    [res] = calls(server, '/jobs/job1/result')
    assert res['rounds'] == 2 and res['result'] == {'pushed': ['FRONT', 'Preview'], 'qa': 'PASS', 'rounds': 2}
    assert res['summary'].startswith('Vòng 2: ')
    assert len({fake(cfg, 'maker', 1)['pid'], fake(cfg, 'qa', 1)['pid'], fake(cfg, 'maker', 2)['pid'], fake(cfg, 'qa', 2)['pid']}) == 4


def test_three_fails_end_with_needs_owner_and_nothing_uploaded(server, run, cfg):
    assert run(server, 'done', env=plan(qa=['fail'])) == 'NEEDS_OWNER'
    assert not puts(server) and not calls(server, SUBMIT) and not calls(server, '/fail')
    [res] = calls(server, '/jobs/job1/result')
    assert res['outcome'] == 'NEEDS_OWNER' and res['rounds'] == 3
    assert res['summary'] == 'QA chưa đạt sau 3 vòng: FRONT: logo chạm tên khách (vòng 3)'
    assert res['result']['qa'] == 'FAIL' and res['result']['pushed'] == [] and res['result']['findings'][0]['passCondition']
    assert fake(cfg, 'qa', 3) and not (jdir(cfg) / 'round-4').exists()


def test_maker_needs_owner_is_posted_and_no_qa_starts(server, run, cfg):
    assert run(server, 'needs-owner') == 'NEEDS_OWNER'
    assert calls(server, '/jobs/job1/result') == [{'outcome': 'NEEDS_OWNER', 'summary': 'Sau 3 vòng tay áo vẫn lệch đường may.', 'rounds': 3,
                                                   'result': {'pushed': [], 'problems': ['tay áo']}}]
    assert not fake(cfg, 'qa', 1) and not puts(server) and not calls(server, SUBMIT)


def test_ready_listing_a_file_outside_deliver_fails_and_uploads_nothing(server, run, cfg):
    assert run(server, 'done', env=plan(maker=['ready-outside'])) == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'vòng 1: READY.json không hợp lệ: file round-1/FRONT.jpg nằm ngoài round-1/deliver/',
                                                 'permanent': False}]
    assert not puts(server) and not fake(cfg, 'qa', 1) and not calls(server, '/result')


def test_ready_is_checked_strictly(tmp_path, job):
    d = tmp_path; deliver = d / 'round-1' / 'deliver'; deliver.mkdir(parents=True)
    (deliver / 'FRONT.jpg').write_bytes(b'x'); (deliver / 'empty.png').write_bytes(b''); (deliver / 'FRONT.psd').write_bytes(b'x')
    (d / 'outside.jpg').write_bytes(b'x')

    def ready(files, **over):
        body = {'round': 1, 'files': files, 'changed': 'Dời tên.', 'unchanged': ''}; body.update(over)
        (d / 'round-1' / 'READY.json').write_text(json.dumps(body), encoding='utf-8')
        return runner.read_ready(d, 1, job())
    ok = {'kind': 'PRINT', 'printArea': 'FRONT', 'file': 'round-1/deliver/FRONT.jpg'}
    res, why = ready([ok]); assert why is None and res['files'][0]['path'] == (deliver / 'FRONT.jpg').resolve()
    for files, over, text in [
        ([], {}, 'không có file nào'), ([ok], {'round': 2}, '"round" phải là 1'), ([ok], {'changed': ''}, 'thiếu "changed"'),
        ([dict(ok, file='round-1/deliver/../../outside.jpg')], {}, 'nằm ngoài round-1/deliver/'),
        ([dict(ok, file=str(d / 'outside.jpg'))], {}, 'nằm ngoài round-1/deliver/'),
        ([dict(ok, file='round-1/deliver/FRONT.psd')], {}, 'không phải .jpg'),
        ([dict(ok, file='round-1/deliver/none.jpg')], {}, 'không thấy file'),
        ([dict(ok, file='round-1/deliver/empty.png')], {}, 'file rỗng'),
        ([dict(ok, kind='PSD')], {}, 'PRINT hoặc MOCKUP'), ([ok, ok], {}, 'có hai file'),
        ([dict(ok, printArea='BACK')], {}, 'vùng in "BACK" không có'),
    ]:
        res, why = ready(files, **over); assert res is None and text in why, (files, over, why)
    (d / 'round-1' / 'READY.json').write_text('{oops', encoding='utf-8')
    assert runner.read_ready(d, 1, job())[1].startswith('không đọc được JSON')
    (d / 'round-1' / 'READY.json').write_text(json.dumps({'round': 1, 'files': [ok], 'changed': 'x', 'unchanged': ''}), encoding='utf-8')
    assert 'chỉ được giao file MOCKUP' in runner.read_ready(d, 1, job(kind='MOCKUP'))[1]


def test_qa_that_changes_a_deliver_file_fails_the_job(server, run, cfg):
    assert run(server, 'done', env=plan(qa=['tamper'])) == 'FAILED'
    [body] = calls(server, '/jobs/job1/fail')
    assert body['permanent'] is False and body['error'].startswith('vòng 1: phiên QA đã thay đổi file giao (round-1/deliver/')
    assert not puts(server) and not calls(server, '/result')


def test_qa_without_a_result_or_with_a_malformed_one_fails(server, run):
    assert run(server, 'done', env=plan(qa=['nothing']), cli_down_window_s=0) == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'vòng 1: phiên QA kết thúc mà không có QA-claude/round-1-result.json', 'permanent': False}]
    assert run(server, 'done', env=plan(qa=['qa-bad']), job=dict(id='job2')) == 'FAILED'
    assert calls(server, '/jobs/job2/fail') == [{'error': 'vòng 1: kết quả QA không hợp lệ: verdict phải là PASS hoặc FAIL', 'permanent': False}]
    assert not puts(server) and not calls(server, '/result')


def test_qa_result_is_checked(tmp_path):
    out = tmp_path / 'QA-claude'; out.mkdir()
    good = {'piece': 'FRONT', 'problem': 'logo chạm tên', 'fix': 'dời logo', 'passCondition': 'cách 40 px'}
    for body, text in [({'verdict': 'PASS', 'summary': 'x', 'findings': [good]}, 'PASS nhưng vẫn có findings'),
                       ({'verdict': 'FAIL', 'summary': 'x', 'findings': []}, 'FAIL mà không có findings'),
                       ({'verdict': 'FAIL', 'summary': 'x', 'findings': [dict(good, fix='')]}, 'thiếu piece'),
                       ({'verdict': 'PASS', 'summary': '', 'findings': []}, 'thiếu summary')]:
        (out / 'round-1-result.json').write_text(json.dumps(body), encoding='utf-8')
        res, why = runner.read_qa(tmp_path, 1); assert res is None and text in why
    (out / 'round-1-result.json').write_text(json.dumps({'verdict': 'FAIL', 'summary': 'x', 'findings': [good]}), encoding='utf-8')
    assert runner.read_qa(tmp_path, 1) == ({'verdict': 'FAIL', 'summary': 'x', 'findings': [good]}, None)
    assert runner.read_qa(tmp_path, 2) == (None, None)


def test_upload_answered_413_fails_for_good_with_a_clear_message_and_no_submit(server, run):
    server.status = {PUT: (413, b'<html><center><h1>413 Request Entity Too Large</h1></center></html>')}
    assert run(server, 'done') == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'tải lên FRONT thất bại: máy chủ trả 413 (file quá lớn)', 'permanent': True}]
    assert not calls(server, SUBMIT) and not calls(server, '/result') and len(puts(server)) == 1


def test_lost_connection_during_upload_is_retried_later_and_names_what_was_sent(server, run, monkeypatch):
    real = agent_api.AgentApi.upload

    def upload(self, key, area, path, mockup=False):
        if mockup:
            raise agent_api.ApiError(None, {'error': agent_api.UPLOAD_LOST})
        return real(self, key, area, path, mockup=mockup)
    monkeypatch.setattr(agent_api.AgentApi, 'upload', upload)
    assert run(server, 'done') == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'tải lên Preview thất bại: mất kết nối khi đang tải lên; đã tải lên trước đó: FRONT',
                                                 'permanent': False}]
    assert not calls(server, SUBMIT)


def test_submit_refused_fails_with_the_servers_words(server, run):
    server.status = {SUBMIT: (400, {'error': 'Thiếu file in', 'missing': ['BACK']})}
    assert run(server, 'done') == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'gửi duyệt thất bại: máy chủ trả 400 (Thiếu file in; thiếu: BACK); '
                                                          'đã tải lên trước đó: FRONT, Preview', 'permanent': True}]
    server.calls.clear(); server.status = {SUBMIT: 502}
    assert run(server, 'done', job=dict(id='job2')) == 'FAILED' and calls(server, '/jobs/job2/fail')[0]['permanent'] is False


def test_mockup_job_uploads_without_submit(server, run, cfg):
    assert run(server, 'done', job=dict(kind='MOCKUP')) == 'DONE'
    assert puts(server) == [{'printArea': 'Preview', 'fileName': 'Preview.png', 'kind': 'MOCKUP'}] and not calls(server, SUBMIT)
    [res] = calls(server, '/jobs/job1/result')
    assert res['result'] == {'pushed': ['Preview'], 'qa': 'PASS', 'rounds': 1}
    assert fake(cfg, 'maker', 1)['argv'][1].startswith('# Design Agent — mockup job')


def test_wall_clock_running_out_during_qa_kills_it_and_fails(server, run, cfg):
    assert run(server, 'done', env=plan(qa=['sleep']), timeout_s=4, cli_down_window_s=0) == 'FAILED'
    [body] = calls(server, '/jobs/job1/fail')
    assert body['permanent'] is True and body['error'].endswith('chưa xong — đã dừng phiên (vòng 1: QA)')
    assert wait_dead(fake(cfg, 'qa', 1)['pid']) and wait_dead(int((jdir(cfg) / 'grandchild.pid').read_text()))
    assert not puts(server) and not calls(server, '/result')


def test_heartbeats_follow_the_phases(server, run):
    assert run(server, 'done', env={'FAKE_CLAUDE_NAP': '1.2'}, heartbeat_s=0.1) == 'DONE'
    stages = [b['stage'] for b in calls(server, '/jobs/job1/heartbeat')]
    assert stages[0] == 'khởi động' and 'vòng 1: codex' in stages and 'vòng 1: QA' in stages
    assert stages.index('vòng 1: codex') < stages.index('vòng 1: QA')
    assert all(b['rounds'] == 1 for b in calls(server, '/jobs/job1/heartbeat')[1:])


def test_round_stage_prefixes_the_sessions_own_line(tmp_path):
    ctx = {'round': 2, 'stage': 'vòng 2: sửa', 'live': True}
    assert runner.round_stage(ctx, tmp_path) == ('vòng 2: sửa', 2)
    (tmp_path / 'stage.txt').write_text('đo khoảng cách\nx', encoding='utf-8')
    assert runner.round_stage(ctx, tmp_path) == ('vòng 2: đo khoảng cách', 2)
    (tmp_path / 'stage.txt').write_text('Vòng 1: codex', encoding='utf-8')
    assert runner.round_stage(ctx, tmp_path) == ('vòng 2: codex', 2)
    assert runner.round_stage(dict(ctx, live=False, stage='tải lên'), tmp_path) == ('tải lên', 2)


def test_cli_that_cannot_start_the_qa_is_cli_down(server, run, cfg):
    assert run(server, 'done', env=plan(qa=['fast-exit'])) == 'CLI_DOWN'
    assert calls(server, '/jobs/job1/fail')[0]['error'].startswith('Claude CLI không chạy được') and not puts(server)


def test_stop_during_qa_posts_nothing(server, deps, job, cfg):
    from conftest import wait_until
    d = deps(server, 'done', env=plan(qa=['sleep'])); stop = threading.Event(); out = []
    t = threading.Thread(target=lambda: out.append(runner.run_job(job(), d, stop))); t.start()
    wait_until(lambda: fake(cfg, 'qa', 1) is not None); stop.set(); t.join(20)
    assert out == ['LOST'] and wait_dead(fake(cfg, 'qa', 1)['pid']) and not calls(server, '/fail') and not calls(server, '/result')
