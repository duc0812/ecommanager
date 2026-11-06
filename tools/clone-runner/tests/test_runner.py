import json
import os
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

import api
import runner
from conftest import fixture

GID = 'gid://shopify/Product/9054123557021'
OK_BEAT = {'ok': True, 'cancelled': False}


def make_job(**over):
    job = {
        'id': 'cmh1a2b3c4d5e6f7',
        'sourceUrl': 'https://shop.example.com/products/family-ornament',
        'skuCode': 'TM0611260001',
        'attempts': 1,
        'requestedByName': 'Seller A',
        'store': {'id': 'store1', 'orderPrefix': 'LIT', 'shop': 'caramiaus-store.myshopify.com'},
        'targets': ['customily:LIT', 'customall:LIT', 'teeinblue:REMI'],
    }
    job.update(over)
    return job


class FakeClient:
    def __init__(self, beat=None, results=None, claims=None, fails=None):
        self.calls = []
        self.beat = beat or (lambda stage, platform: OK_BEAT)
        self.results = list(results or [])
        self.claims = list(claims or [])
        self.fails = list(fails or [])

    def claim(self, wait_seconds=25):
        self.calls.append(('claim', wait_seconds))
        out = self.claims.pop(0)
        if isinstance(out, Exception):
            raise out
        return out

    def heartbeat(self, job_id, attempts, stage=None, platform=None):
        self.calls.append(('heartbeat', job_id, attempts, stage, platform))
        return self.beat(stage, platform)

    def result(self, job_id, attempts, payload):
        self.calls.append(('result', job_id, attempts, payload))
        out = self.results.pop(0) if self.results else (200, {'status': 'DONE'})
        if isinstance(out, Exception):
            raise out
        return out

    def fail(self, job_id, attempts, fail_kind, error, retryable=False, product_gid=None):
        self.calls.append(('fail', job_id, attempts, fail_kind, error, retryable, product_gid))
        out = self.fails.pop(0) if self.fails else {'status': 'FAILED'}
        if isinstance(out, Exception):
            raise out
        return out

    def named(self, name):
        return [c for c in self.calls if c[0] == name]


class FakeClock:
    def __init__(self):
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def make_deps(tmp_path, client=None, html=None, existing=None, session_result=None, session=None):
    sessions, fetched = [], []

    def run_session(job, platform, job_dir, should_stop, timeout_s=7200):
        sessions.append({'job': job, 'platform': platform, 'job_dir': job_dir, 'timeout_s': timeout_s,
                         'dir_existed': os.path.isdir(job_dir)})
        if session:
            return session(should_stop)
        return dict(session_result or {'verdict': 'PASS', 'productGid': GID, 'handle': 'family-ornament'})

    def fetch_html(url):
        fetched.append(url)
        return html

    deps = SimpleNamespace(client=client or FakeClient(), fetch_html=fetch_html, find_existing=lambda job: existing,
                           run_session=run_session, job_root=str(tmp_path), clock=FakeClock())
    deps.sessions, deps.fetched = sessions, fetched
    return deps


def test_validate_job_rejects_hostile_values():
    assert runner.validate_job(make_job()) is None
    assert runner.validate_job(make_job(sourceUrl='https://shop.example.com/products/a?view=ca-pdp-x')) is None
    assert runner.validate_job(make_job(store={'id': 's2', 'orderPrefix': 'REMI', 'shop': 'd1ba2a-75.myshopify.com'})) is None

    hostile_urls = [
        "https://shop.example.com/products/a'b",
        'https://shop.example.com/products/a"b',
        'https://shop.example.com/products/a b',
        'http://shop.example.com/products/a',
        'https://shop.example.com/products/$(calc)',
        'https://shop.example.com/products/a;calc',
        'https://shop.example.com/products/a`calc`',
        'https://shop.example.com/products/a|calc',
        'https://shop.example.com/products/a&calc',
        'https://shop.example.com/products/a?view=x&y=1',
        'https://shop.example.com/products/a\n',
        'https://Shop.example.com/products/a',
        'https://shop.example.com/products/a%20b',
        'https://shop.example.com/p/%DESIGN_WORKER_TOKEN%20',
        'https://shop.example.com/products/%PATH%',
        'https://shop.example.com/products/a,b',
        'https://shop.example.com/products/a+b',
        'https://shop.example.com/products/a@b',
        'https://shop.example.com/products/a=b',
        'https://shop.example.com/products/a:b',
        'https://shop.example.com/products/~a',
        '',
        None,
    ]
    for url in hostile_urls:
        assert runner.validate_job(make_job(sourceUrl=url)), url
    for sku in ['tm0611260001', 'TM061126000', 'TM06112600011', 'TM٠611260001', 'TM0611260001\n', 'T10611260001', None]:
        assert runner.validate_job(make_job(skuCode=sku)), sku
    for store in [{'orderPrefix': 'XYZ'}, {'orderPrefix': 'lit'}, {'orderPrefix': None}, {}, None, 'LIT']:
        assert runner.validate_job(make_job(store=store)), store
    for job_id in ['ABCDEFGHIJKL', 'short', 'a' * 41, '../../etc/passwd', 'abcdefghijkl\n', 12345678901, None]:
        assert runner.validate_job(make_job(id=job_id)), job_id
    assert runner.KNOWN_STORES == {'LIT': 'litzzy', 'REMI': 'reminiso'}


def test_run_job_with_invalid_job_fails_without_spawning(tmp_path):
    deps = make_deps(tmp_path, html=fixture('customily.html'))
    runner.run_job(make_job(sourceUrl='https://shop.example.com/a b'), deps)
    assert deps.sessions == []
    assert deps.fetched == []
    [fail] = deps.client.named('fail')
    assert fail[3] == 'TOOL' and fail[4]
    assert deps.client.named('heartbeat') == []
    assert os.listdir(tmp_path) == []


def test_unsupported_platform_fails_without_session(tmp_path):
    deps = make_deps(tmp_path, html=fixture('globo.html'))
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert ('heartbeat', 'cmh1a2b3c4d5e6f7', 1, 'nhận diện', 'unsupported:globo') in deps.client.calls
    assert deps.client.named('fail') == [
        ('fail', 'cmh1a2b3c4d5e6f7', 1, 'UNSUPPORTED', 'Nền tảng này chưa hỗ trợ (globo).', False, None)]
    assert deps.client.named('result') == []


def test_target_not_enabled_fails_without_session(tmp_path):
    for html in (fixture('customix.html'), fixture('teeinblue.html')):
        deps = make_deps(tmp_path, html=html)
        runner.run_job(make_job(), deps)
        assert deps.sessions == []
        [fail] = deps.client.named('fail')
        assert fail[3] == 'NOT_ENABLED' and fail[4]
    deps = make_deps(tmp_path, html=fixture('customall.html'))
    runner.run_job(make_job(targets=None), deps)
    assert deps.sessions == []
    assert deps.client.named('fail')[0][3] == 'NOT_ENABLED'


def test_existing_register_entry_reports_reused(tmp_path):
    deps = make_deps(tmp_path, html=fixture('customily.html'), existing={'productGid': GID, 'handle': 'family-ornament'})
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert deps.fetched == []
    assert deps.client.named('result') == [('result', 'cmh1a2b3c4d5e6f7', 1, {
        'productGid': GID, 'handle': 'family-ornament', 'qaVerdict': 'PASS',
        'qaNote': 'Đã có sẵn trong sổ đăng ký', 'reused': True})]
    assert deps.client.named('fail') == []


def test_session_pass_reports_result_in_job_folder(tmp_path):
    deps = make_deps(tmp_path, html=fixture('customily.html'), session_result={
        'verdict': 'PASS', 'productGid': GID, 'handle': 'family-ornament', 'note': 'QA PASS', 'costUsd': 1.5,
        'durationMs': 61000})
    job = make_job()
    runner.run_job(job, deps)
    [s] = deps.sessions
    assert s['platform'] == 'customily'
    assert s['job_dir'] == os.path.join(str(tmp_path), 'cmh1a2b3c4d5e6f7')
    assert s['dir_existed'] is True
    assert s['timeout_s'] == 7200
    assert deps.fetched == [job['sourceUrl']]
    beats = deps.client.named('heartbeat')
    assert ('heartbeat', 'cmh1a2b3c4d5e6f7', 1, 'nhận diện', 'customily') in beats
    assert deps.client.named('result') == [('result', 'cmh1a2b3c4d5e6f7', 1, {
        'productGid': GID, 'handle': 'family-ornament', 'qaVerdict': 'PASS', 'qaNote': 'QA PASS', 'costUsd': 1.5,
        'durationMs': 61000})]


def test_unknown_or_unreadable_page_still_opens_session(tmp_path):
    for html in (None, fixture('plain.html')):
        deps = make_deps(tmp_path, html=html)
        runner.run_job(make_job(), deps)
        assert [s['platform'] for s in deps.sessions] == ['unknown']
        assert ('heartbeat', 'cmh1a2b3c4d5e6f7', 1, 'nhận diện', 'unknown') in deps.client.calls
        assert len(deps.client.named('result')) == 1


def test_session_fail_and_unsupported_map_to_fail_calls(tmp_path):
    cases = [
        ({'verdict': 'FAIL', 'failKind': 'QA', 'error': 'qa_report FAIL', 'productGid': GID},
         ('QA', 'qa_report FAIL', False, GID)),
        ({'verdict': 'FAIL', 'error': 'tool crashed'}, ('TOOL', 'tool crashed', False, None)),
        ({'verdict': 'FAIL', 'failKind': 'WHATEVER', 'error': 'x'}, ('TOOL', 'x', False, None)),
        ({'verdict': 'FAIL', 'failKind': 'TOOL_GAP', 'error': 'rule missing'}, ('TOOL_GAP', 'rule missing', False, None)),
        ({'verdict': 'UNSUPPORTED', 'note': 'Trang dùng app lạ'}, ('UNSUPPORTED', 'Trang dùng app lạ', False, None)),
        ({'verdict': 'UNSUPPORTED', 'error': 'zepto', 'note': 'n'}, ('UNSUPPORTED', 'zepto', False, None)),
        ({'verdict': 'MAYBE'}, None),
    ]
    for session_result, expected in cases:
        deps = make_deps(tmp_path, html=fixture('customily.html'), session_result=session_result)
        runner.run_job(make_job(), deps)
        [fail] = deps.client.named('fail')
        assert deps.client.named('result') == []
        if expected is None:
            assert fail[3] == 'TOOL' and fail[4]
        else:
            assert fail[3:] == expected


def test_session_exception_reports_tool_failure(tmp_path):
    def boom(should_stop):
        raise RuntimeError('claude not found')

    deps = make_deps(tmp_path, html=fixture('customily.html'), session=boom)
    runner.run_job(make_job(), deps)
    [fail] = deps.client.named('fail')
    assert fail[3] == 'TOOL' and 'claude not found' in fail[4]


def test_result_502_is_retried_then_fails_retryable(tmp_path):
    client = FakeClient(results=[(502, {'error': 'Shopify unreachable'})] * 6)
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('result')) == 6
    assert deps.clock.sleeps == [30] * 5
    [fail] = client.named('fail')
    assert fail[3] == 'TOOL' and fail[5] is True and fail[6] == GID


def test_result_502_then_done_stops_retrying(tmp_path):
    client = FakeClient(results=[(502, {'error': 'Shopify unreachable'}), (200, {'status': 'DONE'})])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('result')) == 2
    assert deps.clock.sleeps == [30]
    assert client.named('fail') == []


def test_result_network_error_is_retried(tmp_path):
    client = FakeClient(results=[api.NetworkError('result: URLError'), (200, {'status': 'DONE'})])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('result')) == 2
    assert client.named('fail') == []


def test_result_any_5xx_is_retried_like_502(tmp_path):
    client = FakeClient(results=[(500, {}), (503, {}), (504, {}), (500, {}), (599, {}), (500, {})])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('result')) == 6
    assert deps.clock.sleeps == [30] * 5
    [fail] = client.named('fail')
    assert fail[3] == 'TOOL' and fail[5] is True and fail[6] == GID


@pytest.mark.parametrize('status', [400, 409, 302, 301])
def test_result_unexpected_status_fails_the_job_not_retryable(tmp_path, status):
    client = FakeClient(results=[(status, {'error': 'bad'})])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('result')) == 1
    assert deps.clock.sleeps == []
    [fail] = client.named('fail')
    assert fail[3] == 'TOOL' and str(status) in fail[4] and fail[5] is False and fail[6] == GID


def test_result_404_is_logged_only(tmp_path):
    client = FakeClient(results=[(404, {'error': 'not found'})])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert client.named('fail') == []


def test_fail_that_raises_is_retried_three_times_then_given_up(tmp_path, capsys):
    ne = api.NetworkError('fail: URLError')
    client = FakeClient(fails=[ne, api.ApiError('fail: HTTP 500', 500), ne, ne])
    deps = make_deps(tmp_path, client=client, html=fixture('globo.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('fail')) == 4
    assert deps.clock.sleeps == [10, 10, 10]
    assert 'bỏ cuộc' in capsys.readouterr().out


def test_fail_retry_stops_once_it_gets_through(tmp_path):
    client = FakeClient(fails=[api.NetworkError('fail: URLError'), {'status': 'FAILED'}])
    deps = make_deps(tmp_path, client=client, html=fixture('globo.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('fail')) == 2
    assert deps.clock.sleeps == [10]


class JsonResponse:
    def __init__(self, body: dict):
        self.status = 200
        self._raw = json.dumps(body).encode('ascii')

    def read(self, size=-1):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class RoutingOpener:
    REPLIES = {'heartbeat': OK_BEAT, 'result': {'status': 'DONE'}, 'fail': {'status': 'FAILED'}}

    def __init__(self):
        self.sent = []

    def open(self, req, timeout=None):
        action = req.full_url.rsplit('/', 1)[-1]
        self.sent.append((action, req.data))
        return JsonResponse(self.REPLIES[action])


@pytest.mark.parametrize('outcome, action, field, text', [
    ({'verdict': 'PASS', 'productGid': GID, 'note': 'QA ok \ud83d'}, 'result', 'qaNote', 'QA ok \ud83d'),
    ({'verdict': 'FAIL', 'failKind': 'QA', 'error': 'QA lỗi \ud83d'}, 'fail', 'error', 'QA lỗi \ud83d'),
])
def test_lone_surrogate_in_session_text_still_reaches_the_server(tmp_path, outcome, action, field, text):
    opener = RoutingOpener()
    client = api.Client('https://ecom.example.test', 'cqw_' + 'a' * 24, opener=opener)
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'), session_result=outcome)
    runner.run_job(make_job(), deps)
    [raw] = [data for a, data in opener.sent if a == action]
    raw.decode('ascii')
    assert json.loads(raw)[field] == text
    other = 'fail' if action == 'result' else 'result'
    assert [a for a, _ in opener.sent if a == other] == []


@pytest.mark.parametrize('error', [RuntimeError('boom'), UnicodeEncodeError('utf-8', '\ud83d', 0, 1, 'surrogates')])
def test_unexpected_result_error_fails_the_job(tmp_path, error):
    client = FakeClient(results=[error])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('result')) == 1
    assert [f[3:] for f in client.named('fail')] == [('TOOL', runner.RESULT_SEND_ERROR, False, GID)]


def test_fail_is_retried_on_any_error(tmp_path):
    client = FakeClient(fails=[RuntimeError('boom'), {'status': 'FAILED'}])
    deps = make_deps(tmp_path, client=client, html=fixture('globo.html'))
    runner.run_job(make_job(), deps)
    assert len(client.named('fail')) == 2
    assert deps.clock.sleeps == [10]


def test_fail_401_is_not_retried(tmp_path):
    client = FakeClient(fails=[api.AuthError('fail: HTTP 401', 401)])
    deps = make_deps(tmp_path, client=client, html=fixture('globo.html'))
    with pytest.raises(api.AuthError):
        runner.run_job(make_job(), deps)
    assert len(client.named('fail')) == 1


@pytest.mark.parametrize('existing', ['yes', ['gid://shopify/Product/1'], {}, {'handle': 'x'}, {'productGid': 7},
                                      {'productGid': GID, 'handle': 3}, False])
def test_malformed_register_answer_fails_without_session(tmp_path, existing):
    deps = make_deps(tmp_path, html=fixture('customily.html'), existing=existing)
    runner.run_job(make_job(), deps)
    assert deps.sessions == [] and deps.fetched == []
    assert deps.client.named('result') == []
    assert [f[3:6] for f in deps.client.named('fail')] == [('TOOL', runner.SETUP_ERROR, False)]


def test_register_exception_fails_with_fixed_text(tmp_path):
    deps = make_deps(tmp_path, html=fixture('customily.html'))

    def boom(job):
        raise OSError(r'D:\Ecom manager\clipart-clones\x\clone.json unreadable')

    deps.find_existing = boom
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert [f[3:6] for f in deps.client.named('fail')] == [('TOOL', runner.SETUP_ERROR, False)]


def test_job_folder_errors_fail_without_session(tmp_path):
    not_a_dir = tmp_path / 'root-is-a-file'
    not_a_dir.write_text('x', encoding='utf-8')
    deps = make_deps(not_a_dir, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert [f[3:6] for f in deps.client.named('fail')] == [('TOOL', runner.SETUP_ERROR, False)]

    (tmp_path / 'cmh1a2b3c4d5e6f7' / 'stage.txt').mkdir(parents=True)
    deps = make_deps(tmp_path, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert [f[3:6] for f in deps.client.named('fail')] == [('TOOL', runner.SETUP_ERROR, False)]


def test_heartbeat_not_ok_stops_session(tmp_path):
    seen = {}

    def beat(stage, platform):
        return OK_BEAT if stage == 'nhận diện' else {'ok': False, 'cancelled': True}

    def session(should_stop):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if should_stop():
                seen['stopped'] = True
                return {'verdict': 'FAIL', 'failKind': 'TOOL', 'error': 'stopped'}
            time.sleep(0.01)
        return {'verdict': 'PASS', 'productGid': GID}

    client = FakeClient(beat=beat)
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'), session=session)
    runner.run_job(make_job(), deps)
    assert seen.get('stopped') is True
    assert any(c[3] == 'clone' for c in client.named('heartbeat'))
    assert client.named('result') == []
    assert client.named('fail') == []


def test_cancelled_before_session_opens_nothing(tmp_path):
    client = FakeClient(beat=lambda stage, platform: {'ok': True, 'cancelled': True})
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert client.named('result') == [] and client.named('fail') == []


def test_stage_file_from_an_earlier_attempt_is_cleared(tmp_path):
    job_dir = tmp_path / 'cmh1a2b3c4d5e6f7'
    job_dir.mkdir()
    (job_dir / 'stage.txt').write_text('public\n', encoding='utf-8')
    client = FakeClient()

    def session(should_stop):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not [c for c in client.named('heartbeat') if c[3] != 'nhận diện']:
            time.sleep(0.01)
        return {'verdict': 'PASS', 'productGid': GID}

    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'), session=session)
    runner.run_job(make_job(), deps)
    in_session = [c[3] for c in client.named('heartbeat') if c[3] != 'nhận diện']
    assert in_session[:1] == ['clone']


def test_heartbeat_stage_comes_from_stage_file(tmp_path):
    assert runner.read_stage(str(tmp_path)) == 'clone'
    (tmp_path / 'stage.txt').write_text('qa\nmore text\n', encoding='utf-8')
    assert runner.read_stage(str(tmp_path)) == 'qa'
    (tmp_path / 'stage.txt').write_text('  public  \n', encoding='utf-8')
    assert runner.read_stage(str(tmp_path)) == 'public'
    (tmp_path / 'stage.txt').write_text('nhận diện\n', encoding='utf-8')
    assert runner.read_stage(str(tmp_path)) == 'clone'
    (tmp_path / 'stage.txt').write_text('rm -rf\n', encoding='utf-8')
    assert runner.read_stage(str(tmp_path)) == 'clone'


def test_serve_backs_off_and_stops_on_401(tmp_path, capsys):
    ne = api.NetworkError('claim: URLError')
    claims = [ne, ne, {'job': None, 'paused': False}, ne, ne, ne, ne, ne, ne, ne, api.AuthError('401')]
    deps = make_deps(tmp_path, client=FakeClient(claims=claims))
    assert runner.serve(deps) != 0
    assert deps.clock.sleeps == [2, 4, 2, 4, 8, 16, 32, 60, 60]
    assert all(c == ('claim', 25) for c in deps.client.named('claim'))
    assert runner.AUTH_MESSAGE in capsys.readouterr().out


def test_serve_once_runs_one_job(tmp_path):
    client = FakeClient(claims=[{'job': make_job(), 'paused': False}])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    assert runner.serve(deps, once=True) == 0
    assert len(deps.sessions) == 1
    assert len(client.named('claim')) == 1
    assert len(client.named('result')) == 1


LOCK_TOKEN = 'cqw_lock_test_token_0123456789'
HOLD_LOCK = (
    'import sys, time\n'
    'sys.path.insert(0, sys.argv[1])\n'
    'import runner\n'
    'fd = runner.acquire_lock(sys.argv[2])\n'
    'print("locked" if fd is not None else "busy", flush=True)\n'
    'time.sleep(60)\n'
)


def acquire_within(path, seconds=5.0):
    deadline = time.monotonic() + seconds
    while True:
        fd = runner.acquire_lock(path)
        if fd is not None or time.monotonic() > deadline:
            return fd
        time.sleep(0.05)


def test_second_runner_refuses_when_lock_is_held(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('ECOM_URL', 'http://127.0.0.1:9')
    monkeypatch.setenv('CLONE_WORKER_TOKEN', LOCK_TOKEN)
    monkeypatch.setattr(runner, 'default_deps', lambda *a, **k: pytest.fail('must not start'))
    lock = str(tmp_path / 'runner.lock')
    first = runner.acquire_lock(lock)
    assert first is not None
    with open(lock, encoding='ascii') as fh:
        assert fh.read() == str(os.getpid())
    assert runner.acquire_lock(lock) is None
    assert runner.main(['--once', '--job-root', str(tmp_path)]) == 1
    assert LOCK_TOKEN not in capsys.readouterr().out
    runner.release_lock(first)
    second = runner.acquire_lock(lock)
    assert second is not None
    runner.release_lock(second)


def test_lock_is_freed_when_the_holder_dies(tmp_path):
    lock = str(tmp_path / 'runner.lock')
    root = os.path.dirname(os.path.abspath(runner.__file__))
    child = subprocess.Popen([sys.executable, '-c', HOLD_LOCK, root, lock], stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == 'locked'
        assert runner.acquire_lock(lock) is None
    finally:
        child.kill()
        child.wait()
        child.stdout.close()
    fd = acquire_within(lock)
    assert fd is not None
    with open(lock, encoding='ascii') as fh:
        assert fh.read() == str(os.getpid())
    runner.release_lock(fd)


def test_leftover_lock_file_with_a_live_pid_does_not_block(tmp_path):
    lock = tmp_path / 'runner.lock'
    lock.write_text(str(os.getppid()), encoding='ascii')
    fd = runner.acquire_lock(str(lock))
    assert fd is not None
    assert lock.read_text(encoding='ascii') == str(os.getpid())
    runner.release_lock(fd)


def test_main_needs_url_and_token(tmp_path, monkeypatch):
    monkeypatch.delenv('ECOM_URL', raising=False)
    monkeypatch.delenv('CLONE_WORKER_TOKEN', raising=False)
    assert runner.main(['--once', '--job-root', str(tmp_path)]) == 2
    assert not (tmp_path / 'runner.lock').exists()


@pytest.mark.parametrize('token', ['cqw_' + 'a' * 20 + '\r\nX-Evil: 1', 'cqw_tooshort', 'not-a-worker-token-at-all'])
def test_main_refuses_malformed_token_without_printing_it(tmp_path, monkeypatch, capsys, token):
    monkeypatch.setenv('ECOM_URL', 'https://ecom.example.test')
    monkeypatch.setenv('CLONE_WORKER_TOKEN', token)
    monkeypatch.setattr(runner, 'default_deps', lambda *a, **k: pytest.fail('must not start'))
    assert runner.main(['--once', '--job-root', str(tmp_path)]) == 2
    out = capsys.readouterr()
    assert api.BAD_TOKEN_MESSAGE in out.out
    assert token.strip() not in out.out and token.strip() not in out.err
    assert not (tmp_path / 'runner.lock').exists()


@pytest.mark.parametrize('base', ['http://ecom.example.test', 'http://localhost.evil.example:3002'])
def test_main_refuses_cleartext_ecom_url(tmp_path, monkeypatch, capsys, base):
    monkeypatch.setenv('ECOM_URL', base)
    monkeypatch.setenv('CLONE_WORKER_TOKEN', LOCK_TOKEN)
    monkeypatch.setattr(runner, 'default_deps', lambda *a, **k: pytest.fail('must not start'))
    assert runner.main(['--once', '--job-root', str(tmp_path)]) == 2
    out = capsys.readouterr().out
    assert api.BAD_URL_MESSAGE in out and LOCK_TOKEN not in out
    assert not (tmp_path / 'runner.lock').exists()
