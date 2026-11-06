import io
import urllib.error
from email.message import Message
import urllib.request

import pytest

import detect
from conftest import fixture


def test_detect_each_platform():
    assert detect.detect_platform(fixture('customily.html')) == 'customily'
    assert detect.detect_platform(fixture('customall.html')) == 'customall'
    assert detect.detect_platform(fixture('teeinblue.html')) == 'teeinblue'
    assert detect.detect_platform(fixture('customix.html')) == 'customix'
    assert detect.detect_platform(fixture('ymq.html')) == 'unsupported:ymq'
    assert detect.detect_platform(fixture('globo.html')) == 'unsupported:globo'
    assert detect.PLATFORMS == ('customily', 'customall', 'teeinblue', 'customix')


def test_detect_customily_needs_script_host():
    assert detect.detect_platform(fixture('globo.html')) == 'unsupported:globo'
    assert detect.detect_platform(fixture('plain.html')) == 'unknown'
    for host in ('cdn.customily.com', 'sh.customily.com', 'app.customily.com'):
        assert detect.detect_platform(f'<script src="https://{host}/x.js"></script>') == 'customily'


def test_detect_precedence_and_empty_page():
    both = fixture('ymq.html') + fixture('globo.html') + fixture('customix.html')
    assert detect.detect_platform(both) == 'customix'
    assert detect.detect_platform(fixture('ymq.html') + fixture('globo.html')) == 'unsupported:globo'
    assert detect.detect_platform(fixture('customall.html') + fixture('customily.html')) == 'customily'
    assert detect.detect_platform('') == 'unknown'
    assert detect.detect_platform('<div class="gpo-option"></div>') == 'unsupported:globo'
    assert detect.detect_platform('<div class="ymq_option"></div>') == 'unsupported:ymq'


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200, charset: str = 'utf-8'):
        self._body = io.BytesIO(body)
        self.status = status
        self.headers = Message()
        self.headers['Content-Type'] = f'text/html; charset={charset}'
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return self._body.read(size)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    def __init__(self, outcome):
        self.outcome = outcome
        self.requests = []

    def open(self, req, timeout=None):
        self.requests.append((req, timeout))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def test_fetch_html_returns_text_and_sends_browser_user_agent():
    resp = FakeResponse(fixture('customall.html').encode('utf-8'))
    opener = FakeOpener(resp)
    html = detect.fetch_html('https://shop.example.com/products/a', opener=opener, timeout=7)
    assert 'apis-v2.customall.io' in html
    req, timeout = opener.requests[0]
    assert timeout == 7
    assert 'Mozilla/5.0' in req.get_header('User-agent')
    assert resp.read_sizes == [3 * 1024 * 1024]


@pytest.mark.parametrize('outcome', [
    urllib.error.HTTPError('https://shop.example.com/p', 429, 'Too Many Requests', {}, io.BytesIO(b'')),
    urllib.error.URLError('down'),
    TimeoutError('slow'),
    FakeResponse(b'<html></html>', status=203),
])
def test_fetch_html_returns_none_on_error_or_non_200(outcome):
    assert detect.fetch_html('https://shop.example.com/p', opener=FakeOpener(outcome)) is None


def test_fetch_html_refuses_non_https():
    opener = FakeOpener(FakeResponse(b'<html></html>'))
    assert detect.fetch_html('http://shop.example.com/p', opener=opener) is None
    assert opener.requests == []


def test_redirects_only_to_https():
    handler = detect.HttpsOnlyRedirect()
    req = urllib.request.Request('https://shop.example.com/a')
    assert handler.redirect_request(req, None, 302, 'Found', {}, 'http://shop.example.com/b') is None
    follow = handler.redirect_request(req, None, 302, 'Found', {}, 'https://shop.example.com/b')
    assert follow is not None and follow.full_url == 'https://shop.example.com/b'
