import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import auto_render as ar

TOKEN = 'dwt_secret_test_token'
PROD_URL = 'https://ecom.example.test'


@pytest.fixture(autouse=True)
def _own_mutex(monkeypatch):
    real = ar.acquire_mutex
    name = r'Local\EcomManagerAutoRenderHourlyApiTest-' + uuid.uuid4().hex
    monkeypatch.setattr(ar, 'acquire_mutex', lambda *a, **k: real(name))


@pytest.fixture
def prod_env(tmp_path, monkeypatch):
    profile = tmp_path / 'profile'
    monkeypatch.setenv('USERPROFILE', str(profile))

    def write(**keys):
        p = profile / '.artwork-worker' / 'prod.env'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(''.join(f'{k}={v}\n' for k, v in keys.items()), encoding='utf-8')
        return p
    return write


def test_default_is_ssh_and_never_reads_prod_env(cfg_file, prod_env):
    prod_env(ECOM_URL=PROD_URL, DESIGN_WORKER_TOKEN=TOKEN)
    cfg = ar.load_config(cfg_file())
    assert (cfg.push_via, cfg.worker_token, cfg.ecom_url) == ('ssh', '', '')
    assert ar.load_config(cfg_file(PUSH_VIA='SSH')).push_via == 'ssh'


def test_api_reads_token_and_url_from_prod_env_config_env_wins(cfg_file, prod_env):
    prod_env(ECOM_URL=PROD_URL + '/', DESIGN_WORKER_TOKEN=TOKEN)
    cfg = ar.load_config(cfg_file(PUSH_VIA='api'))
    assert (cfg.push_via, cfg.worker_token, cfg.ecom_url) == ('api', TOKEN, PROD_URL)
    cfg = ar.load_config(cfg_file(PUSH_VIA='api', ECOM_URL='https://other.example.test', DESIGN_WORKER_TOKEN='dwt_own'))
    assert (cfg.worker_token, cfg.ecom_url) == ('dwt_own', 'https://other.example.test')


def test_api_config_errors_are_loud(cfg_file, prod_env):
    with pytest.raises(ar.ConfigError, match='PUSH_VIA phải là ssh hoặc api'):
        ar.load_config(cfg_file(PUSH_VIA='vps'))
    with pytest.raises(ar.ConfigError, match='PUSH_VIA=api cần ECOM_URL và DESIGN_WORKER_TOKEN'):
        ar.load_config(cfg_file(PUSH_VIA='api'))                                   # no prod.env at all
    prod_env(ECOM_URL=PROD_URL)
    with pytest.raises(ar.ConfigError, match='PUSH_VIA=api cần'):
        ar.load_config(cfg_file(PUSH_VIA='api'))
    prod_env(ECOM_URL='http://example.com', DESIGN_WORKER_TOKEN=TOKEN)
    with pytest.raises(ar.ConfigError, match='ECOM_URL phải là https'):
        ar.load_config(cfg_file(PUSH_VIA='api'))


STARTED = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)


def _iso(d):
    return d.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def test_api_outcome_reads_the_newest_delivery_of_the_task():
    after, before = _iso(STARTED + timedelta(minutes=2)), _iso(STARTED - timedelta(days=1))
    ledger = {'lines': {
        'LIT1_1#old': {'taskKey': 'LIT1_1', 'files': {}, 'supersededAt': after},
        'LIT1_1#new': {'taskKey': 'LIT1_1', 'files': {}, 'applied': after, 'result': {'status': 'REVIEW'}},
        'LIT2_1#a': {'taskKey': 'LIT2_1', 'files': {}, 'skippedOnProd': {'code': 'not_found', 'error': 'task không có', 'status': 404}},
        'LIT3_1#a': {'taskKey': 'LIT3_1', 'files': {}, 'skippedOnProd': {'code': 'stale', 'error': 'task trên prod đang REVIEW', 'status': None}},
        'LIT4_1#a': {'taskKey': 'LIT4_1', 'files': {}, 'applied': before, 'result': {}},
        'LIT5_1#a': {'taskKey': 'LIT5_1', 'files': {}, 'applied': after},
    }}
    assert ar.api_outcome(ledger, 'LIT1_1', STARTED) == 'pushed'
    cases = {'LIT2_1': 'bỏ qua trên prod: 404 not_found task không có', 'LIT3_1': 'kế hoạch cũ so với prod (stale): task trên prod đang REVIEW',
             'LIT4_1': 'api-ledger không ghi nhận dòng', 'LIT5_1': 'api-ledger không ghi nhận dòng', 'LIT9_1': 'api-ledger không ghi nhận dòng'}
    for key, text in cases.items():
        with pytest.raises(ar.StageError) as e:
            ar.api_outcome(ledger, key, STARTED)
        assert (e.value.stage, e.value.task_key) == ('push', key) and text in e.value.message
    with pytest.raises(ar.StageError, match='không ghi nhận'):
        ar.api_outcome({}, 'LIT1_1', STARTED)


def _api_world(world, prod_env, **kw):
    prod_env(ECOM_URL=PROD_URL, DESIGN_WORKER_TOKEN=TOKEN)
    return world(extra={'PUSH_VIA': 'api'}, **kw)


def _push_calls(w):
    return [c for c in w.node.calls() if 'push-' in c['script']]


def test_api_mode_runs_each_cli_once_with_via_api_and_the_env(world, prod_env):
    w = _api_world(world, prod_env, lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))],
                   flat=[dict(key='LIT7_1', readiness='AUTO', values={'Custom Name': 'Anna'})])
    assert ar.main(['--config', str(w.config)]) == 0
    assert sorted(w.summary()['pushed']) == ['LIT1_1', 'LIT7_1']
    local, shared = _push_calls(w)
    assert local['script'].endswith('push-local-renders.mjs') and shared['script'].endswith('push-shared-prints.mjs')
    assert local['args'] == ['--snapshot', str(w.snapshot), '--since', w.summary()['since'], '--line', 'LIT1_1', '--via', 'api']
    a = shared['args']
    assert a[a.index('--out') + 1] == str(w.home / 'flat-ledger') and a[a.index('--spec') + 1].endswith('.auto.json') and a[-2:] == ['--via', 'api']
    assert not any(s in c['args'] for c in (local, shared) for s in ar.STAGES)
    env = [json.loads(l) for l in (w.node.dir / 'api-env.jsonl').read_text(encoding='utf-8').splitlines()]
    assert env == [{'ECOM_URL': PROD_URL, 'DESIGN_WORKER_TOKEN': TOKEN}] * 2
    assert TOKEN not in w.log() and 'auth=***' in w.log()                         # the token never reaches the log


def test_api_mode_never_takes_the_push_lock(world, prod_env, monkeypatch):
    w = _api_world(world, prod_env, lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))])
    (w.artwork_builder / '.push-lock').mkdir()                                   # another session holds it

    def no_lock(*a, **k):
        raise AssertionError('PushLock taken in api mode')
    monkeypatch.setattr(ar, 'PushLock', no_lock)
    assert ar.main(['--config', str(w.config)]) == 0 and w.summary()['pushed'] == ['LIT1_1']
    assert (w.artwork_builder / '.push-lock').exists() and not (w.home / 'push-lock.owner').exists()


@pytest.mark.parametrize('outcome, text', [('skipped', 'bỏ qua trên prod: 404 not_found'), ('stale', 'kế hoạch cũ so với prod (stale)'),
                                           ('noledger', 'api-ledger không ghi nhận dòng'), ('old', 'api-ledger không ghi nhận dòng'),
                                           ('exit1', 'push-local-renders --via api thoát mã 1'), ('stop', 'thoát mã 1')])
def test_api_mode_failures_stop_the_push_like_today(world, prod_env, outcome, text):
    w = _api_world(world, prod_env, lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                                           dict(key='LIT4_1', readiness='AUTO', ink=(210, 110, 390, 150))], push={'LIT1_1': outcome})
    assert ar.main(['--config', str(w.config)]) == 1
    s = w.summary()
    assert s['pushed'] == [] and s['errors'][0]['stage'] == 'push' and s['errors'][0]['taskKey'] == 'LIT1_1' and text in s['errors'][0]['message']
    assert not any('LIT4_1' in c['args'] for c in w.node.calls())


def test_ssh_mode_passes_no_api_env_and_no_via(world, prod_env):
    prod_env(ECOM_URL=PROD_URL, DESIGN_WORKER_TOKEN=TOKEN)
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))])
    assert ar.main(['--config', str(w.config)]) == 0 and w.summary()['pushed'] == ['LIT1_1']
    assert [c['args'][-1] for c in _push_calls(w)] == list(ar.STAGES) and not any('--via' in c['args'] for c in _push_calls(w))
    assert not (w.node.dir / 'api-env.jsonl').exists()
