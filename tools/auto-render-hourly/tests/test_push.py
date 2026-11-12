import json
import os
from pathlib import Path

import pytest

import auto_render as ar
from conftest import DEAD_PID, FakeClock


def test_end_to_end_pushes_passing_auto_lines_and_holds_the_rest(world):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                     dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150)),
                     dict(key='LIT2_1', readiness='LOW', ink=(210, 110, 390, 150))], hold=True)
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert (s['pushed'], s['notAuto'], s['rendered']) == (['LIT1_1'], ['LIT2_1'], ['LIT1_1', 'LIT2_1', 'LIT3_1'])
    assert s['held'] == [{'taskKey': 'LIT3_1', 'source': 'local-render', 'guard': 'BOX',
                          'reason': 'tên vượt khung 15 px (Print · Custom Name)', 'reported': True, 'jobId': 'job-1'}]
    assert w.agent.holds == [{'taskKey': 'LIT3_1', 'reason': 'tên vượt khung 15 px (Print · Custom Name)'}]
    stages = [c['args'][-1] for c in w.node.calls() if c['script'].endswith('push-local-renders.mjs')]
    assert stages == ['--apply', '--prove', '--push'] and not (w.artwork_builder / '.push-lock').exists()
    assert not w.snapshot.exists()                                             # own snapshot dropped


def test_dry_run_does_everything_but_push_and_hold(world):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                     dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True)
    assert ar.main(['--config', str(w.config), '--dry-run']) == 0
    s = w.summary()
    assert s['dryRun'] and s['pushed'] == [] and s['held'][0]['reported'] is False and w.agent.holds == []
    assert not any('push-' in c['script'] for c in w.node.calls()) and not (w.home / 'holds.json').exists()


def test_stop_or_missing_ledger_is_never_reported_pushed(world):                # Review Focus 2
    for outcome, text in [('stop', 'app không online'), ('noledger', 'ledger không ghi nhận'), ('exit1', 'thoát mã 1')]:
        w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                         dict(key='LIT4_1', readiness='AUTO', ink=(210, 110, 390, 150))], push={'LIT1_1': outcome})
        assert ar.main(['--config', str(w.config)]) == 1
        s = w.summary(); assert s['pushed'] == [] and text in s['errors'][0]['message'] and s['errors'][0]['taskKey'] == 'LIT1_1'
        assert not any('LIT4_1' in c['args'] for c in w.node.calls())           # the phase stopped


def test_skipped_on_prod_is_reported_as_skipped(world):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))], push={'LIT1_1': 'skipped'})
    assert ar.main(['--config', str(w.config)]) == 0
    assert w.summary()['skipped'] == [{'taskKey': 'LIT1_1', 'reason': 'Task trên prod đang REVIEW'}]


def test_lock_waits_then_gives_up_without_breaking_it(tmp_path):
    lock = tmp_path / '.push-lock'; lock.mkdir(); clock = FakeClock()
    with pytest.raises(ar.LockBusy):
        with ar.PushLock(lock, tmp_path, wait_s=1800, poll_s=10, sleep=clock.sleep, clock=clock.now): pass
    assert lock.exists() and clock.slept == 1800


def _marker(tmp_path, pid, lock, identity=None):
    ino, ctime_ns = identity or ar.lock_identity(lock)
    (tmp_path / 'push-lock.owner').write_text(json.dumps({'pid': pid, 'ino': ino, 'ctimeNs': ctime_ns}))


def test_own_stale_lock_is_recovered_another_holders_is_not(tmp_path):          # Review Focus 1
    lock = tmp_path / '.push-lock'; lock.mkdir(); _marker(tmp_path, DEAD_PID, lock)
    with ar.PushLock(lock, tmp_path, wait_s=0):
        assert json.loads((tmp_path / 'push-lock.owner').read_text())['pid'] == os.getpid()
    assert not lock.exists() and not (tmp_path / 'push-lock.owner').exists()
    lock.mkdir(); (tmp_path / 'push-lock.owner').write_text(str(os.getpid()))   # a live pid: not ours to break
    with pytest.raises(ar.LockBusy):
        with ar.PushLock(lock, tmp_path, wait_s=0): pass
    assert lock.exists()


def test_hold_is_reported_once_per_reason(world):                               # Review Focus 3
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True)
    ar.main(['--config', str(w.config)]); w.rerun(); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 1 and w.summary()['held'][0]['reported'] is True
    w.rerun(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 440, 150))]); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 2


def test_hold_without_config_is_log_only_and_a_refused_hold_fails_the_run(world):
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=False)
    assert ar.main(['--config', str(w.config)]) == 0 and 'chưa cấu hình /hold — chỉ ghi log' in w.log()
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True, token='wrong')
    assert ar.main(['--config', str(w.config)]) == 1
    assert w.summary()['errors'][0] == {'stage': 'hold', 'taskKey': 'LIT3_1', 'message': '/hold trả 401'} and 'wrong' not in w.log()


def test_flat_text_goes_through_its_own_stable_ledger(world):
    w = world(flat=[dict(key='LIT7_1', readiness='AUTO', values={'Custom Name': 'Anna'})])
    assert ar.main(['--config', str(w.config)]) == 0 and w.summary()['pushed'] == ['LIT7_1']
    call = next(c for c in w.node.calls() if c['script'].endswith('push-shared-prints.mjs'))
    assert call['args'][call['args'].index('--out') + 1] == str(w.home / 'flat-ledger') and call['args'][call['args'].index('--spec') + 1].endswith('.auto.json')


def test_stale_marker_never_breaks_a_lock_it_did_not_create(tmp_path):        # review fix 2
    lock = tmp_path / '.push-lock'; lock.mkdir()
    real = ar.lock_identity(lock)
    _marker(tmp_path, DEAD_PID, lock, identity=(real[0] + 1, real[1] + 1))   # our killed run's lock was cleared, another session took it
    with pytest.raises(ar.LockBusy):
        with ar.PushLock(lock, tmp_path, wait_s=0): pass
    assert lock.exists() and not (tmp_path / 'push-lock.owner').exists()
    (tmp_path / 'push-lock.owner').write_text(str(DEAD_PID))                    # a marker without identity proves nothing
    with pytest.raises(ar.LockBusy):
        with ar.PushLock(lock, tmp_path, wait_s=0): pass
    assert lock.exists()


def test_failed_process_run_drops_the_snapshot_it_made(world):                 # review minor
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))])
    plan = json.loads((w.node.dir / 'plan.json').read_text(encoding='utf-8'))
    plan['process']['exit'] = 1
    w.node.plan(**plan)
    other = w.snapshot.with_name('prod-snap-20261111-0800.db'); other.write_bytes(b'x')
    assert ar.main(['--config', str(w.config)]) == 1
    assert not w.snapshot.exists() and other.exists()
    assert w.summary()['errors'][0]['message'] == 'process-new-orders thoát mã 1'


def test_failed_release_of_own_lock_is_loud_and_fails_the_run(world, monkeypatch):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))])
    real = Path.rmdir

    def deny(self):
        if self.name == '.push-lock':
            raise PermissionError('denied')
        return real(self)
    monkeypatch.setattr(Path, 'rmdir', deny)
    assert ar.main(['--config', str(w.config)]) == 1
    err = next(e for e in w.summary()['errors'] if e['stage'] == 'lock')
    assert 'KHÔNG nhả được khoá .push-lock' in err['message'] and 'PermissionError' in err['message'] and 'KHÔNG nhả được khoá' in w.log()


def test_hold_answered_without_a_job_is_sent_again_until_a_job_comes_back(world):
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True)
    w.agent.job_id = None
    ar.main(['--config', str(w.config)]); w.rerun(); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 2
    w.agent.job_id = 'job-9'; w.rerun(); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 3 and w.summary()['held'][0]['jobId'] == 'job-9'
    w.rerun(); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 3
