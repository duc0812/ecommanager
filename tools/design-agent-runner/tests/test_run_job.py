import json
import threading
from pathlib import Path

import pytest

import runner
from conftest import calls, wait_dead


def test_done_session_is_reported_with_its_own_words(server, run, cfg):
    assert run(server, 'done') == 'DONE'
    assert calls(server, '/jobs/job1/result') == [{'outcome': 'DONE', 'summary': 'Đã sửa thân trước: dời tên vào trong khung.', 'rounds': 1,
                                                   'result': {'pushed': ['FRONT'], 'problems': []}}]
    d = cfg.artwork_builder / 'LIT6262_1-agent-job1'
    fake = json.loads((d / 'fake.json').read_text(encoding='utf-8'))
    assert Path(fake['cwd']) == cfg.project_dir and fake['argv'][0] == '-p' and fake['env']['DESIGN_AGENT_TOKEN'] is None
    assert (d / 'current' / 'PRINT-FRONT-v1.jpg').exists()
    assert calls(server, '/jobs/job1/heartbeat')[0] == {'stage': 'khởi động', 'rounds': 0}
    assert ('POST', '/api/design-agent/runner/tasks/LIT6262_1/submit', {}) in server.calls and not calls(server, '/fail')
    assert json.loads((d / 'runner-state.json').read_text(encoding='utf-8'))['outcome'] == 'DONE'


def test_server_may_downgrade_done_and_the_runner_does_not_retry(server, run):
    server.result_reply = {'ok': True, 'status': 'NEEDS_OWNER'}
    assert run(server, 'done') == 'NEEDS_OWNER' and len(calls(server, '/jobs/job1/result')) == 1


def test_needs_owner_is_passed_on(server, run):
    assert run(server, 'needs-owner') == 'NEEDS_OWNER'
    assert calls(server, '/jobs/job1/result')[0]['summary'] == 'Sau 3 vòng tay áo vẫn lệch đường may.'


def test_missing_result_is_a_failure_never_a_success(server, run):
    assert run(server, 'no-result', cli_down_window_s=0) == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'phiên kết thúc mà không có result.json', 'permanent': False}] and not calls(server, '/result')


def test_stale_result_of_an_earlier_attempt_is_not_reported(server, run, cfg):   # Review Focus 1
    d = cfg.artwork_builder / 'LIT6262_1-agent-job1'; d.mkdir(parents=True)
    (d / 'result.json').write_text('{"outcome": "DONE", "summary": "lần trước"}', encoding='utf-8')
    assert run(server, 'no-result', cli_down_window_s=0, job=dict(attempts=2)) == 'FAILED' and not calls(server, '/result')


def test_invalid_result_is_a_permanent_failure(server, run):
    assert run(server, 'bad-outcome') == 'FAILED'
    body = calls(server, '/jobs/job1/fail')[0]; assert body['permanent'] is True and body['error'].startswith('result.json không hợp lệ: ')


def test_cli_that_cannot_run_is_cli_down(server, run):
    assert run(server, 'fast-exit') == 'CLI_DOWN'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'Claude CLI không chạy được (chưa đăng nhập, hết hạn mức hoặc lỗi khởi động)', 'permanent': False}]
    assert run(server, 'done', claude_cmd=[str(Path('no-such-claude.exe'))], job=dict(id='job2')) == 'CLI_DOWN'


def test_wall_clock_kills_the_whole_tree_and_fails_for_good(server, run, cfg):
    assert run(server, 'sleep', timeout_s=3, cli_down_window_s=0) == 'FAILED'
    assert calls(server, '/jobs/job1/fail')[0]['permanent'] is True and 'chưa xong — đã dừng phiên' in calls(server, '/jobs/job1/fail')[0]['error']
    d = cfg.artwork_builder / 'LIT6262_1-agent-job1'
    assert wait_dead(json.loads((d / 'fake.json').read_text())['pid']) and wait_dead(int((d / 'grandchild.pid').read_text()))


def test_killed_session_gives_back_the_photoshop_lock_only_with_its_marker(server, run, cfg):   # Review Focus 2
    assert run(server, 'ps-lock', timeout_s=3, cli_down_window_s=0) == 'FAILED' and not (cfg.artwork_builder / '.ps-lock').exists()
    (cfg.artwork_builder / '.ps-lock').mkdir()                                    # someone else's lock, no marker of ours
    assert run(server, 'sleep', timeout_s=3, cli_down_window_s=0, job=dict(id='job3')) == 'FAILED' and (cfg.artwork_builder / '.ps-lock').exists()


def test_lost_lease_kills_the_session_and_posts_nothing(server, run, cfg):
    server.heartbeat_status = 409; server.heartbeat_ok_first = 1
    assert run(server, 'sleep', heartbeat_s=0.5) == 'LOST' and not calls(server, '/result') and not calls(server, '/fail')
    assert wait_dead(json.loads((cfg.artwork_builder / 'LIT6262_1-agent-job1' / 'fake.json').read_text())['pid'])


def test_unsafe_job_gets_no_folder(server, run, cfg):                             # Review Focus 5
    assert run(server, 'done', job=dict(key='../evil')) == 'FAILED'
    assert calls(server, '/fail')[0] == {'error': 'mã task không hợp lệ', 'permanent': True}
    assert list(cfg.artwork_builder.iterdir()) == [] and not (cfg.artwork_builder.parent / 'evil-agent-job1').exists()


def test_token_is_masked_in_the_session_log_and_download_failure_fails_the_job(server, run, cfg):
    assert run(server, 'echo-token') == 'DONE'
    assert server.token not in (cfg.artwork_builder / 'LIT6262_1-agent-job1' / 'session.log').read_text(encoding='utf-8', errors='replace')
    server.files = {}
    assert run(server, 'done', job=dict(id='job4')) == 'FAILED'
    assert calls(server, '/jobs/job4/fail') == [{'error': 'không tải được file hiện tại của task (HTTP 404)', 'permanent': False}]


def test_stop_event_kills_the_session_and_posts_nothing(server, cfg, deps, job):
    d = deps(server, 'sleep'); stop = threading.Event()
    t = threading.Thread(target=lambda: out.append(runner.run_job(job(), d, stop))); out = []; t.start()
    from conftest import fake_pid
    pid = fake_pid(d, 'LIT6262_1-agent-job1'); stop.set(); t.join(20)
    assert out == ['LOST'] and wait_dead(pid) and not calls(server, '/result') and not calls(server, '/fail')


class StepClock:
    """monotonic advances only by the seconds slept."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def monotonic(self):
        return self.now

    def time(self):
        return self.now


def test_network_error_while_reporting_is_retried_for_the_window_then_left_to_the_lease(server, run, monkeypatch, capsys):
    import agent_api
    seen = []

    def down(self, *a, **k):
        seen.append(1)
        raise agent_api.ApiError(None, {'error': 'mạng'})
    monkeypatch.setattr(agent_api.AgentApi, 'result', down)
    clock = StepClock()
    assert run(server, 'done', clock=clock, report_window_s=900, report_retry_s=10) == 'LOST'
    assert len(seen) > 3 and 880 <= sum(clock.sleeps) <= 900 and max(clock.sleeps) <= 120
    assert clock.sleeps[:3] == [10, 20, 40]
    assert not calls(server, '/fail')
    out = capsys.readouterr().out
    assert 'KHÔNG GỬI ĐƯỢC' in out and 'job1' in out and 'lease' in out


def test_5xx_on_result_is_retried_until_the_server_answers(server, run):
    server.sequence['/jobs/job1/result'] = [502, 503]
    clock = StepClock()
    assert run(server, 'done', clock=clock, report_window_s=900, report_retry_s=10) == 'DONE'
    assert len(calls(server, '/jobs/job1/result')) == 3 and clock.sleeps == [10, 20] and not calls(server, '/fail')


def test_409_on_result_means_the_server_already_has_an_outcome(server, run, capsys):
    server.sequence['/jobs/job1/result'] = [409]
    clock = StepClock()
    assert run(server, 'done', clock=clock) == 'LOST'
    assert len(calls(server, '/jobs/job1/result')) == 1 and not calls(server, '/fail') and clock.sleeps == []
    assert 'đã có kết quả' in capsys.readouterr().out


def test_4xx_on_result_is_final_and_fails_the_job_for_good(server, run):
    server.sequence['/jobs/job1/result'] = [400]
    clock = StepClock()
    assert run(server, 'done', clock=clock) == 'FAILED'
    assert len(calls(server, '/jobs/job1/result')) == 1 and clock.sleeps == []
    [fail] = calls(server, '/jobs/job1/fail')
    assert fail['permanent'] is True and '400' in fail['error']


def test_fail_is_retried_on_5xx_and_final_on_4xx(server, run):
    server.sequence['/jobs/job1/fail'] = [500]
    clock = StepClock()
    assert run(server, 'no-result', cli_down_window_s=0, clock=clock, report_retry_s=10) == 'FAILED'
    assert len(calls(server, '/jobs/job1/fail')) == 2 and clock.sleeps == [10]
    server.calls.clear()
    server.sequence['/jobs/job1/fail'] = [404]
    clock = StepClock()
    assert run(server, 'no-result', cli_down_window_s=0, clock=clock, report_retry_s=10) == 'FAILED'
    assert len(calls(server, '/jobs/job1/fail')) == 1 and clock.sleeps == []


def test_409_on_the_first_beat_starts_no_session(server, run, cfg):
    server.heartbeat_status = 409
    assert run(server, 'sleep') == 'LOST' and not calls(server, '/result') and not calls(server, '/fail')
    assert not (cfg.artwork_builder / 'LIT6262_1-agent-job1' / 'fake.json').exists()


def test_uncontained_session_is_logged(server, deps, job, monkeypatch, capsys):
    import runner as r
    proc = r.load_proc()
    real = proc.spawn

    def spawn(*a, **k):
        child = real(*a, **k)
        child.job = None
        return child
    monkeypatch.setattr(proc, 'spawn', spawn)
    assert r.run_job(job(), deps(server, 'done'), threading.Event()) == 'DONE'
    out = capsys.readouterr().out
    assert 'job1' in out and 'Job Object' in out
