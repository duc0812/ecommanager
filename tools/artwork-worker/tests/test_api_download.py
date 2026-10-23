import hashlib

import pytest

import api as api_mod
from api import ApiError, WorkerApi

DATA = b'psd-bytes' * 1000
SHA = hashlib.sha256(DATA).hexdigest()


class Resp:
    def __init__(self, status=200, body=b'', headers=None, payload=None):
        self.status_code, self.body, self.headers, self.payload = status, body, headers or {}, payload
        self.content = body or b'{}'

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def json(self):
        return self.payload

    def iter_content(self, size):
        for i in range(0, len(self.body), size):
            yield self.body[i:i + size]


DIRECT = {'url': 'https://www.googleapis.com/drive/v3/files/abc?alt=media', 'accessToken': 'ya29.test', 'sha256': SHA, 'size': len(DATA)}


def client(monkeypatch, server_responses, google):
    api = WorkerApi('https://tool.example', 'dsw_' + 'x' * 30)
    calls = {'server': [], 'google': []}

    def server_get(url, params=None, **k):
        calls['server'].append(params)
        return server_responses.pop(0)

    def google_get(url, headers=None, **k):
        calls['google'].append((url, headers))
        return google
    monkeypatch.setattr(api.s, 'get', server_get)
    monkeypatch.setattr(api_mod.requests, 'get', google_get)
    return api, calls


def test_a_drive_file_comes_straight_from_google(monkeypatch, tmp_path):
    api, calls = client(monkeypatch, [Resp(payload=DIRECT, headers={'Content-Type': 'application/json'})], Resp(body=DATA))
    assert api.download('f1', str(tmp_path / 'a.psd')) == SHA
    assert (tmp_path / 'a.psd').read_bytes() == DATA
    assert calls['server'] == [{'direct': '1'}]
    assert calls['google'] == [(DIRECT['url'], {'Authorization': 'Bearer ya29.test'})]


def test_google_refusing_falls_back_to_the_server_stream(monkeypatch, tmp_path):
    server = [Resp(payload=DIRECT, headers={'Content-Type': 'application/json'}), Resp(body=DATA, headers={'X-Content-SHA256': SHA})]
    api, calls = client(monkeypatch, server, Resp(status=403))
    assert api.download('f1', str(tmp_path / 'a.psd')) == SHA
    assert calls['server'] == [{'direct': '1'}, None]


def test_a_server_file_streams_in_one_request_and_a_bad_hash_is_refused(monkeypatch, tmp_path):
    api, calls = client(monkeypatch, [Resp(body=DATA, headers={'Content-Type': 'image/vnd.adobe.photoshop', 'X-Content-SHA256': SHA})], None)
    assert api.download('f1', str(tmp_path / 'a.psd')) == SHA and calls['google'] == []
    api, _ = client(monkeypatch, [Resp(body=DATA, headers={'Content-Type': 'image/vnd.adobe.photoshop'})], None)
    with pytest.raises(ApiError):
        api.download('f1', str(tmp_path / 'b.psd'), 'f' * 64)
    assert not (tmp_path / 'b.psd').exists()


def test_the_token_is_never_sent_outside_google(monkeypatch, tmp_path):
    evil = {**DIRECT, 'url': 'https://evil.example/steal'}
    server = [Resp(payload=evil, headers={'Content-Type': 'application/json'}), Resp(body=DATA, headers={'X-Content-SHA256': SHA})]
    api, calls = client(monkeypatch, server, Resp(body=DATA))
    assert api.download('f1', str(tmp_path / 'a.psd')) == SHA
    assert calls['google'] == []
