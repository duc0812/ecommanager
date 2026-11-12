import json
import threading
import time

import agent_api
import runner
from conftest import FakeClock, calls, fake_pid, max_running, wait_dead, wait_until


def test_never_more_sessions_than_slots(server, deps, job):
    server.jobs = [job(id=f'j{i}', key=f'LIT{i}_1') for i in range(4)]
    d = deps(server, 'no-result', env={'FAKE_CLAUDE_SLEEP': '2'}, MAX_CONCURRENT='2', cli_down_window_s=0)
    stop = threading.Event(); t = threading.Thread(target=runner.serve, args=(d,), kwargs={'stop': stop}); t.start()
    wait_until(lambda: len(calls(server, '/fail')) == 4, within=30); stop.set(); t.join(10)
    frees = [b['free'] for b in calls(server, '/claim')]
    assert frees[0] == 2 and max(frees) <= 2 and all(b['waitSeconds'] == 25 for b in calls(server, '/claim'))
    assert max_running(server) == 2                                               # from heartbeat and fail timestamps the fake server keeps


def test_once_runs_the_claimed_jobs_to_the_end(server, deps, job):
    server.jobs = [job(id='j1'), job(id='j2', key='LIT7_1')]
    assert runner.serve(deps(server, 'done'), once=True) == runner.EXIT_OK
    assert sorted(p for _, p, _ in server.calls if p.endswith('/result')) == ['/api/design-agent/runner/jobs/j1/result', '/api/design-agent/runner/jobs/j2/result']


def test_cli_down_pauses_claiming(server, deps, job):                             # Review Focus 3
    server.jobs = [job(id='j1'), job(id='j2', key='LIT7_1'), job(id='j3', key='LIT8_1')]
    d = deps(server, 'fast-exit', MAX_CONCURRENT='1', cli_backoff_s=3600)
    stop = threading.Event(); t = threading.Thread(target=runner.serve, args=(d,), kwargs={'stop': stop}); t.start()
    wait_until(lambda: len(calls(server, '/fail')) == 1); time.sleep(2); stop.set(); t.join(10)
    assert len(calls(server, '/claim')) == 1 and len(server.jobs) == 2            # two jobs still queued, attempts untouched
    assert runner.serve(deps(server, 'fast-exit'), once=True) == runner.EXIT_CLI


def test_revoked_token_stops_everything_with_exit_3(server, deps, job):           # Review Focus 4
    server.jobs = [job(id='j1')]
    d = deps(server, 'sleep', heartbeat_s=0.5)
    t = threading.Thread(target=lambda: results.append(runner.serve(d))); results = []; t.start()
    wait_until(lambda: calls(server, '/jobs/j1/heartbeat')); server.status = {'/': 401}; t.join(30)
    assert results == [runner.EXIT_AUTH] and wait_dead(fake_pid(d, 'LIT6262_1-agent-j1'))
    assert runner.serve(deps(server, 'done'), once=True) == runner.EXIT_AUTH      # a dead token at the first claim


def test_server_down_backs_off_and_low_disk_holds_claims(server, deps, job):
    server.status = {'/claim': 500}; sleeps = []
    d = deps(server, 'done', clock=FakeClock(sleeps)); stop = threading.Event()
    FakeClock.stop_after(sleeps, 5, stop); runner.serve(d, stop=stop)
    assert sleeps[:5] == [2, 4, 8, 16, 32]
    server.status = {}; server.jobs = [job(id='j1')]; stop = threading.Event(); FakeClock.stop_after(sleeps, 7, stop)
    runner.serve(d, stop=stop, disk_free_gb=lambda path: 12.0)
    assert server.jobs and not calls(server, '/jobs/j1/heartbeat')


def test_second_runner_exits_quietly_and_restart_leaves_jobs_to_the_lease(server, env_file, cfg, monkeypatch):
    lock = runner.acquire_lock(agent_api.home() / 'runner.lock')
    try: assert runner.main(['--once', '--config', str(env_file(server))]) == runner.EXIT_OK and not calls(server, '/claim')
    finally: runner.release_lock(lock)
    old = cfg.artwork_builder / 'LIT5_1-agent-jobX'; old.mkdir()
    (old / 'runner-state.json').write_text('{"jobId": "jobX", "attempt": 1, "finished": false}', encoding='utf-8')
    (old / 'ps-lock.held').write_text(''); (cfg.artwork_builder / '.ps-lock').mkdir()
    assert runner.main(['--once', '--config', str(env_file(server))]) == runner.EXIT_OK
    assert json.loads((old / 'runner-state.json').read_text(encoding='utf-8'))['abandoned'] is True
    assert not (cfg.artwork_builder / '.ps-lock').exists() and not any('jobX' in p for _, p, _ in server.calls)
    assert runner.main(['--config', str(agent_api.home() / 'none.env')]) == runner.EXIT_CONFIG
