import io
import json
import socket
import urllib.error
import urllib.request

import pytest

import api

TOKEN = 'cqw_SECRET_0123456789abcdef'
BASE = 'https://ecom.example.test/'


class FakeResponse:
    def __init__(self, status: int, body: dict | None):
        self.status = status
        self._raw = b'' if body is None else json.dumps(body).encode('utf-8')

    def read(self, size=-1):
        return self._raw

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(status: int, body: dict | None):
    raw = b'' if body is None else json.dumps(body).encode('utf-8')
    return urllib.error.HTTPError('https://ecom.example.test/x', status, 'err', {}, io.BytesIO(raw))


class FakeOpener:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def open(self, req, timeout=None):
        self.calls.append({
            'url': req.full_url,
            'method': req.get_method(),
            'body': json.loads(req.data.decode('utf-8')),
            'auth': req.get_header('Authorization'),
            'type': req.get_header('Content-type'),
            'timeout': timeout,
        })
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


def test_claim_posts_wait_seconds_with_bearer_and_long_timeout():
    job = {'id': 'abcdefghij12', 'sourceUrl': 'https://a.example.com/p'}
    opener = FakeOpener(FakeResponse(200, {'job': job, 'paused': False}))
    client = api.Client(BASE, TOKEN, opener=opener)
    assert client.claim() == {'job': job, 'paused': False}
    call = opener.calls[0]
    assert call['url'] == 'https://ecom.example.test/api/clone-worker/claim'
    assert call['method'] == 'POST'
    assert call['body'] == {'waitSeconds': 25}
    assert call['auth'] == f'Bearer {TOKEN}'
    assert call['type'] == 'application/json'
    assert call['timeout'] == 40


def test_heartbeat_fail_and_result_bodies():
    opener = FakeOpener(
        FakeResponse(200, {'ok': True, 'cancelled': False}),
        FakeResponse(200, {'ok': True, 'cancelled': False}),
        FakeResponse(200, {'status': 'FAILED'}),
        FakeResponse(200, {'status': 'FAILED'}),
        http_error(502, {'error': 'Shopify unreachable'}),
        http_error(404, {'error': 'not found'}),
    )
    client = api.Client(BASE, TOKEN, opener=opener)
    assert client.heartbeat('job1234567', 1) == {'ok': True, 'cancelled': False}
    client.heartbeat('job1234567', 1, stage='nhận diện', platform='unsupported:globo')
    assert client.fail('job1234567', 2, 'UNSUPPORTED', 'Nền tảng này chưa hỗ trợ (globo).') == {'status': 'FAILED'}
    client.fail('job1234567', 2, 'TOOL', 'x' * 5000, retryable=True, product_gid='gid://shopify/Product/9')
    assert client.result('job1234567', 1, {'productGid': 'gid://shopify/Product/9', 'qaVerdict': 'PASS'}) == (
        502, {'error': 'Shopify unreachable'})
    assert client.result('job1234567', 1, {'productGid': 'gid://shopify/Product/9'})[0] == 404

    hb1, hb2, f1, f2, r1, _ = opener.calls
    assert hb1['url'].endswith('/api/clone-worker/jobs/job1234567/heartbeat')
    assert hb1['body'] == {'attempts': 1}
    assert hb2['body'] == {'attempts': 1, 'stage': 'nhận diện', 'platform': 'unsupported:globo'}
    assert f1['url'].endswith('/jobs/job1234567/fail')
    assert f1['body'] == {'attempts': 2, 'failKind': 'UNSUPPORTED', 'error': 'Nền tảng này chưa hỗ trợ (globo).'}
    assert f2['body']['retryable'] is True
    assert f2['body']['productGid'] == 'gid://shopify/Product/9'
    assert len(f2['body']['error']) <= 2000
    assert r1['url'].endswith('/jobs/job1234567/result')
    assert r1['body'] == {'attempts': 1, 'productGid': 'gid://shopify/Product/9', 'qaVerdict': 'PASS'}


def test_job_id_is_quoted_in_the_path():
    opener = FakeOpener(FakeResponse(200, {'status': 'FAILED'}))
    api.Client(BASE, TOKEN, opener=opener).fail('../../x y', 1, 'TOOL', 'bad')
    assert opener.calls[0]['url'] == 'https://ecom.example.test/api/clone-worker/jobs/..%2F..%2Fx%20y/fail'


@pytest.mark.parametrize('outcome, error', [
    (http_error(500, {'error': f'bad token {TOKEN}'}), api.ApiError),
    (http_error(401, {'error': f'Unauthorized {TOKEN}'}), api.AuthError),
    (urllib.error.URLError(f'cannot reach host with {TOKEN}'), api.NetworkError),
    (socket.timeout('timed out'), api.NetworkError),
    (ConnectionResetError('reset'), api.NetworkError),
])
def test_client_never_puts_token_in_errors(outcome, error, capsys):
    client = api.Client(BASE, TOKEN, opener=FakeOpener(outcome))
    with pytest.raises(error) as info:
        client.heartbeat('job1234567', 1)
    assert TOKEN not in str(info.value)
    assert TOKEN not in repr(info.value)
    assert TOKEN not in repr(client)
    out = capsys.readouterr()
    assert TOKEN not in out.out and TOKEN not in out.err


def test_401_on_result_raises_auth_error():
    client = api.Client(BASE, TOKEN, opener=FakeOpener(http_error(401, {'error': 'Unauthorized'})))
    with pytest.raises(api.AuthError):
        client.result('job1234567', 1, {'productGid': 'gid://shopify/Product/1'})


def test_client_does_not_follow_redirects():
    req = urllib.request.Request('https://ecom.example.test/api/clone-worker/claim', headers={'Authorization': 'x'})
    assert api.NoRedirect().redirect_request(req, None, 301, 'Moved', {}, 'https://elsewhere.example/claim') is None
    client = api.Client(BASE, TOKEN)
    assert any(isinstance(h, api.NoRedirect) for h in client._opener.handlers)


def test_client_requires_url_and_token():
    with pytest.raises(ValueError):
        api.Client('', TOKEN)
    with pytest.raises(ValueError):
        api.Client(BASE, '')


@pytest.mark.parametrize('token', [
    TOKEN + '\r\nX-Evil: 1',
    TOKEN + '\n',
    'cqw_short',
    'dsw_' + 'a' * 30,
    'cqw_' + 'a' * 19,
    'cqw_' + 'a' * 20 + ' ',
    'cqw_' + 'a' * 20 + '%',
    None,
])
def test_client_refuses_a_malformed_token_without_echoing_it(token):
    with pytest.raises(ValueError) as info:
        api.Client(BASE, token)
    assert str(info.value) == api.BAD_TOKEN_MESSAGE
    if token:
        assert token.strip() not in str(info.value) and token.strip() not in repr(info.value)
    api.Client(BASE, 'cqw_' + 'a' * 20)


@pytest.mark.parametrize('base, ok', [
    ('https://ecom.example.test', True),
    ('https://ecom.example.test/', True),
    ('http://localhost:3002', True),
    ('http://LOCALHOST', True),
    ('http://127.0.0.1:3013/', True),
    ('http://ecom.example.test', False),
    ('http://localhost.evil.example', False),
    ('http://localhost@evil.example', False),
    ('http://127.0.0.1.evil.example', False),
    ('ftp://ecom.example.test', False),
    ('https://', False),
    ('ecom.example.test', False),
])
def test_client_refuses_cleartext_base_url(base, ok):
    if ok:
        api.Client(base, TOKEN)
        return
    with pytest.raises(ValueError) as info:
        api.Client(base, TOKEN)
    assert str(info.value) == api.BAD_URL_MESSAGE
