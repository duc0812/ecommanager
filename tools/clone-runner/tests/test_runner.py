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
    def __init__(self, calls=None):
        self.sleeps = []
        self.now = 0.0
        self.calls = calls

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        if self.calls is not None:
            self.calls.append(('sleep', seconds))

    def monotonic(self):
        return self.now


GB = 1024 ** 3


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
                           run_session=run_session, job_root=str(tmp_path), clock=FakeClock(),
                           disk_usage=lambda path: SimpleNamespace(free=100 * GB), cli_backoff_s=1800,
                           scan_parents=lambda root: ([], []))
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


@pytest.mark.parametrize('vector', json.loads(fixture('link_vectors.json'))['hosts'], ids=lambda v: v['url'])
def test_source_url_host_must_be_a_public_name_like_the_server_says(vector):
    assert bool(runner.SOURCE_URL_RE.fullmatch(vector['url'])) is vector['ok']
    assert (runner.validate_job(make_job(sourceUrl=vector['url'])) is None) is vector['ok']


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


@pytest.mark.parametrize('results, retryable', [
    ([(502, {})] * 6, True),
    ([(409, {'error': 'bad'})], False),
    ([RuntimeError('boom')], False),
])
def test_a_reused_jobs_fail_never_names_the_register_product(tmp_path, results, retryable):
    client = FakeClient(results=results)
    deps = make_deps(tmp_path, client=client, existing={'productGid': GID, 'handle': 'family-ornament'})
    runner.run_job(make_job(), deps)
    [fail] = client.named('fail')
    assert fail[3] == 'TOOL' and fail[5] is retryable and fail[6] is None


def test_forced_job_skips_the_register_and_opens_a_session(tmp_path):
    looked = []
    deps = make_deps(tmp_path, html=fixture('customily.html'))
    deps.find_existing = lambda job: looked.append(job) or {'productGid': GID, 'handle': 'old'}
    runner.run_job(make_job(force=True), deps)
    assert looked == [] and len(deps.sessions) == 1
    assert 'reused' not in deps.client.named('result')[0][3]
    runner.run_job(make_job(force='true'), deps)
    assert len(looked) == 1 and len(deps.sessions) == 1


def test_a_session_reused_is_never_forwarded(tmp_path):
    deps = make_deps(tmp_path, html=fixture('customily.html'), session_result={
        'verdict': 'PASS', 'productGid': GID, 'handle': 'someone-elses-product', 'reused': True})
    runner.run_job(make_job(), deps)
    [call] = deps.client.named('result')
    assert 'reused' not in call[3] and call[3]['productGid'] == GID


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


def test_heartbeat_keeps_the_lease_while_the_result_is_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, 'HEARTBEAT_S', 0.01)
    client = FakeClient()
    beat_during = []

    def result(job_id, attempts, payload):
        client.calls.append(('result', job_id, attempts, payload))
        seen = len(client.named('heartbeat'))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and len(client.named('heartbeat')) == seen:
            time.sleep(0.01)
        beat_during.append(len(client.named('heartbeat')) > seen)
        return (502, {}) if len(beat_during) == 1 else (200, {'status': 'DONE'})

    client.result = result
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'))
    runner.run_job(make_job(), deps)
    assert beat_during == [True, True]
    after = len(client.named('heartbeat'))
    time.sleep(0.1)
    assert len(client.named('heartbeat')) == after


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
    recorded = (tmp_path / 'runner.log').read_text(encoding='utf-8')
    assert api.BAD_TOKEN_MESSAGE in recorded and token.strip() not in recorded
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


def wait_until(check, seconds=5.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.01)
    return check()


def test_heartbeat_stops_by_itself_at_its_cap(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(runner, 'HEARTBEAT_S', 0.01)
    clock, client = FakeClock(), FakeClient()
    hb = runner.Heartbeat(client, make_job(), str(tmp_path), clock=clock)
    hb.start()
    try:
        assert wait_until(lambda: len(client.named('heartbeat')) >= 3)
        clock.now = runner.HEARTBEAT_CAP_S - 1
        assert wait_until(lambda: len(client.named('heartbeat')) >= 6)
        assert not hb.should_stop()
        clock.now = runner.HEARTBEAT_CAP_S
        assert wait_until(hb.should_stop)
        assert wait_until(lambda: not hb._thread.is_alive())
        beats = len(client.named('heartbeat'))
        time.sleep(0.05)
        assert len(client.named('heartbeat')) == beats
    finally:
        hb.close()
    assert runner.HEARTBEAT_CAPPED in capsys.readouterr().out
    assert runner.HEARTBEAT_CAP_S == runner.SESSION_TIMEOUT_S + 30 * 60


def test_a_runner_stuck_past_the_cap_loses_the_job(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, 'HEARTBEAT_S', 0.01)
    box = {}

    def session(should_stop):
        box['deps'].clock.now = runner.HEARTBEAT_CAP_S + 1
        assert wait_until(should_stop)
        return {'verdict': 'PASS', 'productGid': GID}

    deps = make_deps(tmp_path, html=fixture('customily.html'), session=session)
    box['deps'] = deps
    runner.run_job(make_job(), deps)
    assert deps.client.named('result') == [] and deps.client.named('fail') == []


class BrokenConsole:
    encoding = 'utf-8'

    def write(self, text):
        raise OSError(22, 'console write failed')

    def flush(self):
        raise OSError(22, 'console flush failed')


@pytest.fixture
def log_file(tmp_path):
    path = tmp_path / 'runner.log'
    runner.set_log_file(str(path))
    yield path
    runner.set_log_file(None)


def test_log_lines_reach_the_runner_log(log_file, capsys):
    runner.log('một dòng log')
    runner.log('lone \ud83d surrogate')
    text = log_file.read_text(encoding='utf-8')
    assert 'một dòng log' in text and 'lone \\ud83d surrogate' in text and text.count('\n') == 2
    assert 'một dòng log' in capsys.readouterr().out
    runner.set_log_file(None)
    runner.log('not recorded')
    assert 'not recorded' not in log_file.read_text(encoding='utf-8')


def test_a_console_that_raises_does_not_break_log(log_file, monkeypatch):
    monkeypatch.setattr(sys, 'stdout', BrokenConsole())
    runner.log('still recorded')
    runner.log('still recorded \ud83d')
    assert log_file.read_text(encoding='utf-8').count('still recorded') == 2


def test_runner_log_rotates_once_it_passes_its_size(log_file, monkeypatch):
    assert runner.LOG_MAX_BYTES == 5 * 1024 * 1024
    monkeypatch.setattr(runner, 'LOG_MAX_BYTES', 100)
    older = log_file.parent / 'runner.log.1'
    log_file.write_text('y' * 100, encoding='utf-8')
    older.write_text('older', encoding='utf-8')
    runner.log('not yet')
    assert older.read_text(encoding='utf-8') == 'older' and log_file.read_text(encoding='utf-8').startswith('y' * 100)
    runner.log('after the rotation')
    assert older.read_text(encoding='utf-8').startswith('y' * 100) and 'not yet' in older.read_text(encoding='utf-8')
    lines = log_file.read_text(encoding='utf-8').splitlines()
    assert len(lines) == 1 and lines[0].endswith('after the rotation')


def test_main_records_even_its_first_lines_in_the_job_roots_log(tmp_path, monkeypatch):
    monkeypatch.delenv('ECOM_URL', raising=False)
    monkeypatch.delenv('CLONE_WORKER_TOKEN', raising=False)
    root = tmp_path / 'new-root'
    assert runner.main(['--once', '--job-root', str(root)]) == 2
    assert 'Thiếu ECOM_URL' in (root / 'runner.log').read_text(encoding='utf-8')
    runner.log('after main')
    assert 'after main' not in (root / 'runner.log').read_text(encoding='utf-8')


def test_start_up_logs_parent_settings_and_switches_quick_edit_off(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv('ECOM_URL', 'https://ecom.example.test')
    monkeypatch.setenv('CLONE_WORKER_TOKEN', LOCK_TOKEN)
    asked = []
    monkeypatch.setattr(runner, 'disable_quick_edit', lambda: asked.append(True))
    settings = r'D:\Ecom manager\.claude\settings.local.json'
    scanned = []

    def deps_for(client, job_root):
        deps = make_deps(tmp_path, client=FakeClient(claims=[{'job': None, 'paused': False}]))
        deps.scan_parents = lambda root: scanned.append(root) or ([], [settings])
        return deps

    monkeypatch.setattr(runner, 'default_deps', deps_for)
    assert runner.main(['--once', '--job-root', str(tmp_path)]) == 0
    assert asked == [True] and scanned == [str(tmp_path)]
    assert settings in capsys.readouterr().out
    recorded = (tmp_path / 'runner.log').read_text(encoding='utf-8')
    assert settings in recorded and LOCK_TOKEN not in recorded


class Tty:
    def __init__(self, tty):
        self.tty = tty

    def isatty(self):
        return self.tty


class FakeKernel32:
    def __init__(self, mode=0x0047, get_ok=True, set_ok=True):
        self.mode, self.get_ok, self.set_ok = mode, get_ok, set_ok
        self.calls = []

    def GetStdHandle(self, which):
        self.calls.append(('GetStdHandle', which))
        return 7

    def GetConsoleMode(self, handle, ptr):
        self.calls.append(('GetConsoleMode', handle))
        if self.get_ok:
            ptr.contents.value = self.mode
        return int(self.get_ok)

    def SetConsoleMode(self, handle, mode):
        self.calls.append(('SetConsoleMode', handle, mode))
        return int(self.set_ok)


windows_only = pytest.mark.skipif(os.name != 'nt', reason='the console API is Windows only')


@windows_only
def test_quick_edit_is_switched_off_on_a_console(capsys):
    k32 = FakeKernel32(mode=0x0047)
    runner.disable_quick_edit(stdin=Tty(True), kernel32=k32)
    assert k32.calls == [('GetStdHandle', -10), ('GetConsoleMode', 7), ('SetConsoleMode', 7, 0x0087)]
    assert capsys.readouterr().out == ''


@windows_only
def test_quick_edit_is_left_alone_without_a_console(capsys):
    k32 = FakeKernel32()
    runner.disable_quick_edit(stdin=Tty(False), kernel32=k32)
    runner.disable_quick_edit(kernel32=k32)
    assert k32.calls == []
    k32 = FakeKernel32(get_ok=False)
    runner.disable_quick_edit(stdin=Tty(True), kernel32=k32)
    assert [c[0] for c in k32.calls] == ['GetStdHandle', 'GetConsoleMode']
    assert capsys.readouterr().out == ''


@windows_only
def test_quick_edit_failure_is_logged_and_not_fatal(capsys):
    runner.disable_quick_edit(stdin=Tty(True), kernel32=FakeKernel32(set_ok=False))

    class Broken(FakeKernel32):
        def GetStdHandle(self, which):
            raise OSError('no console')

    runner.disable_quick_edit(stdin=Tty(True), kernel32=Broken())
    assert capsys.readouterr().out.count(runner.QUICK_EDIT_FAILED) == 2


CLI_DOWN = {'verdict': 'FAIL', 'failKind': 'TOOL', 'cliDown': True,
            'error': 'Claude CLI không chạy được (chưa đăng nhập, hết hạn mức hoặc lỗi khởi động).'}


def test_a_cli_down_job_fails_retryable_without_a_product(tmp_path, capsys):
    deps = make_deps(tmp_path, html=fixture('customily.html'), session_result={**CLI_DOWN, 'productGid': GID})
    assert runner.run_job(make_job(), deps) is True
    assert deps.client.named('fail') == [('fail', 'cmh1a2b3c4d5e6f7', 1, 'TOOL', CLI_DOWN['error'], True, None)]
    assert deps.client.named('result') == []
    assert runner.CLI_DOWN_MESSAGE in capsys.readouterr().out
    deps = make_deps(tmp_path, html=fixture('customily.html'),
                     session_result={'verdict': 'FAIL', 'failKind': 'TOOL', 'error': 'x', 'cliDown': 'yes'})
    assert runner.run_job(make_job(), deps) is False
    assert [f[5] for f in deps.client.named('fail')] == [False]
    assert runner.run_job(make_job(), make_deps(tmp_path, html=fixture('customily.html'))) is False


def test_cli_down_never_reaches_the_server(tmp_path):
    opener = RoutingOpener()
    client = api.Client('https://ecom.example.test', 'cqw_' + 'a' * 24, opener=opener)
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'), session_result=CLI_DOWN)
    assert runner.run_job(make_job(), deps) is True
    [raw] = [data for a, data in opener.sent if a == 'fail']
    assert json.loads(raw) == {'attempts': 1, 'failKind': 'TOOL', 'error': CLI_DOWN['error'], 'retryable': True}


def test_serve_backs_off_after_a_cli_down_job_and_claims_nothing_meanwhile(tmp_path):
    calls = []
    client = FakeClient(claims=[{'job': make_job(), 'paused': False}, {'job': None, 'paused': False},
                                api.AuthError('401')])
    client.calls = calls
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'), session_result=CLI_DOWN)
    deps.clock = FakeClock(calls)
    deps.cli_backoff_s = 1234
    assert runner.serve(deps) == 3
    assert [c for c in calls if c[0] in ('claim', 'fail', 'sleep')] == [
        ('claim', 25), ('fail', 'cmh1a2b3c4d5e6f7', 1, 'TOOL', CLI_DOWN['error'], True, None), ('sleep', 1234),
        ('claim', 25), ('claim', 25)]


def test_once_exits_4_after_a_cli_down_job(tmp_path):
    client = FakeClient(claims=[{'job': make_job(), 'paused': False}])
    deps = make_deps(tmp_path, client=client, html=fixture('customily.html'), session_result=CLI_DOWN)
    assert runner.serve(deps, once=True) == 4
    assert deps.clock.sleeps == [] and len(client.named('claim')) == 1


def test_cli_backoff_comes_from_the_environment(tmp_path, monkeypatch):
    assert runner.cli_backoff_s({}) == 1800
    for raw, want in (('600', 600), (' 60 ', 60), ('0', 1800), ('abc', 1800), ('-5', 1800), ('1.5', 1800),
                      ('٦٠', 1800), ('', 1800)):
        assert runner.cli_backoff_s({'CLONE_CLI_BACKOFF_S': raw}) == want, raw
    monkeypatch.setenv('CLONE_CLI_BACKOFF_S', '900')
    assert runner.default_deps(FakeClient(), str(tmp_path)).cli_backoff_s == 900


def test_the_sessions_platform_goes_out_in_a_last_heartbeat_when_the_runner_could_not_tell(tmp_path):
    deps = make_deps(tmp_path, html=None, session_result={'verdict': 'PASS', 'productGid': GID,
                                                          'platform': 'customily'})
    runner.run_job(make_job(), deps)
    calls = deps.client.calls
    before = calls[:calls.index(deps.client.named('result')[0])]
    assert [c for c in before if c[0] == 'heartbeat' and c[4] == 'customily'] == [
        ('heartbeat', 'cmh1a2b3c4d5e6f7', 1, 'clone', 'customily')]
    assert len(deps.client.named('result')) == 1


@pytest.mark.parametrize('html, said', [
    (None, 'Customily'), (None, 'unknown'), (None, 'unsupported:Evil!'), (None, 'unsupported:' + 'a' * 21),
    (None, 'customily\n'), (None, 7), (None, None), ('customily.html', 'customall'),
])
def test_no_last_heartbeat_for_a_known_platform_or_an_odd_word(tmp_path, html, said):
    outcome = {'verdict': 'PASS', 'productGid': GID}
    if said is not None:
        outcome['platform'] = said
    deps = make_deps(tmp_path, html=fixture(html) if html else None, session_result=outcome)
    runner.run_job(make_job(), deps)
    beats = deps.client.named('heartbeat')
    assert [c for c in beats if c[3] != 'nhận diện' and c[4] is not None] == []
    assert len(deps.client.named('result')) == 1


def test_a_last_heartbeat_that_says_cancelled_stops_the_report(tmp_path):
    client = FakeClient(beat=lambda stage, platform: {'ok': platform != 'customall', 'cancelled': False})
    deps = make_deps(tmp_path, client=client, html=None, session_result={
        'verdict': 'UNSUPPORTED', 'platform': 'customall', 'error': 'x'})
    runner.run_job(make_job(), deps)
    assert client.named('result') == [] and client.named('fail') == []
    assert ('heartbeat', 'cmh1a2b3c4d5e6f7', 1, 'clone', 'customall') in client.calls


def test_a_claude_md_above_the_job_root_fails_the_job(tmp_path, capsys):
    found = r'D:\Ecom manager\CLAUDE.md'
    settings = r'D:\Ecom manager\.claude\settings.local.json'
    deps = make_deps(tmp_path, html=fixture('customily.html'))
    deps.scan_parents = lambda root: ([found], [settings])
    runner.run_job(make_job(), deps)
    assert deps.sessions == []
    assert [f[3:] for f in deps.client.named('fail')] == [
        ('TOOL', 'Có file CLAUDE.md ở thư mục cha của hàng chờ — gỡ ra rồi thử lại.', False, None)]
    assert found in capsys.readouterr().out
    deps = make_deps(tmp_path, html=fixture('customily.html'))
    deps.scan_parents = lambda root: ([], [settings])
    runner.run_job(make_job(), deps)
    assert len(deps.sessions) == 1 and deps.client.named('fail') == []


def test_parent_instruction_files_walk_up_from_the_job_root(tmp_path):
    top = tmp_path / 'a'
    root = top / 'b' / 'clone-queue'
    root.mkdir(parents=True)
    (root / 'CLAUDE.local.md').write_text('x', encoding='utf-8')
    (top / 'b' / '.claude').mkdir()
    for name in ('settings.local.json', 'CLAUDE.md', 'other.json'):
        (top / 'b' / '.claude' / name).write_text('{}', encoding='utf-8')
    (top / 'CLAUDE.md').write_text('x', encoding='utf-8')
    (top / '.claude').write_text('a file, not a folder', encoding='utf-8')
    (tmp_path / '.claude').mkdir()
    (tmp_path / '.claude' / 'settings.json').write_text('{}', encoding='utf-8')
    (tmp_path / 'CLAUDE.md').write_text('above the top', encoding='utf-8')
    memory, settings = runner.parent_instruction_files(str(root), top=str(top))
    assert memory == [str(root / 'CLAUDE.local.md'), str(top / 'b' / '.claude' / 'CLAUDE.md'), str(top / 'CLAUDE.md')]
    assert settings == [str(top / 'b' / '.claude' / 'settings.local.json')]
    memory, settings = runner.parent_instruction_files(str(root))
    assert str(tmp_path / 'CLAUDE.md') in memory and str(tmp_path / '.claude' / 'settings.json') in settings
    clean = tmp_path / 'clean' / 'queue'
    clean.mkdir(parents=True)
    assert runner.parent_instruction_files(str(clean), top=str(tmp_path / 'clean')) == ([], [])


def test_serve_waits_instead_of_claiming_on_a_full_disk(tmp_path, capsys):
    calls = []
    client = FakeClient(claims=[api.AuthError('401')])
    client.calls = calls
    deps = make_deps(tmp_path, client=client)
    deps.clock = FakeClock(calls)
    free, asked = [1 * GB, 2 * GB - 1, 2 * GB], []
    deps.disk_usage = lambda path: asked.append(path) or SimpleNamespace(free=free.pop(0))
    assert runner.serve(deps) == 3
    assert calls == [('sleep', 300), ('sleep', 300), ('claim', 25)]
    assert asked == [str(tmp_path)] * 3
    assert capsys.readouterr().out.count(runner.LOW_DISK_MESSAGE) == 2


def test_once_with_a_full_disk_claims_nothing(tmp_path):
    deps = make_deps(tmp_path, client=FakeClient(claims=[]))
    deps.disk_usage = lambda path: SimpleNamespace(free=0)
    assert runner.serve(deps, once=True) == 1
    assert deps.client.named('claim') == [] and deps.clock.sleeps == []


def test_runner_help_exits_0():
    done = subprocess.run([sys.executable, runner.__file__, '--help'], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and '--once' in done.stdout
