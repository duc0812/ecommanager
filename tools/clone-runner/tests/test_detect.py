import http.client
import io
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from email.message import Message

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

    def read1(self, size=-1):
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
    assert resp.read_sizes and all(0 < s <= 65536 for s in resp.read_sizes)


def test_fetch_html_reads_at_most_three_megabytes():
    resp = FakeResponse(b'a' * (detect.MAX_BYTES + 100000))
    html = detect.fetch_html('https://shop.example.com/p', opener=FakeOpener(resp))
    assert len(html) == detect.MAX_BYTES
    assert all(0 < s <= 65536 for s in resp.read_sizes)


@pytest.mark.parametrize('outcome', [
    urllib.error.HTTPError('https://shop.example.com/p', 429, 'Too Many Requests', {}, io.BytesIO(b'')),
    urllib.error.URLError('down'),
    TimeoutError('slow'),
    FakeResponse(b'<html></html>', status=203),
])
def test_fetch_html_returns_none_on_error_or_non_200(outcome):
    assert detect.fetch_html('https://shop.example.com/p', opener=FakeOpener(outcome)) is None


class SocketOpener:
    """Builds a real http.client.HTTPResponse over one end of a local socket pair (no network)."""

    def __init__(self, sock):
        self.sock = sock

    def open(self, req, timeout=None):
        self.sock.settimeout(timeout)
        resp = http.client.HTTPResponse(self.sock, method='GET')
        resp.begin()
        return resp


def drip(sock, head: bytes, stop: threading.Event, every: float, max_s: float = 8) -> None:
    until = time.monotonic() + max_s
    try:
        sock.sendall(head)
        while not stop.wait(every) and time.monotonic() < until:
            sock.sendall(b'x')
    except OSError:
        pass


def fetch_threads_alive() -> bool:
    return any(t.name == 'fetch-html' and t.is_alive() for t in threading.enumerate())


def wait_until(check, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return check()


BODY_DRIP = b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1000000\r\n\r\n<html>'
HEADER_DRIP = b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Slow: '


@pytest.mark.parametrize('head', [BODY_DRIP, HEADER_DRIP], ids=['body-drip', 'header-drip'])
def test_fetch_html_gives_up_after_its_total_budget(head):
    assert wait_until(lambda: not fetch_threads_alive(), 5)
    reader, writer = socket.socketpair()
    stop = threading.Event()
    dripper = threading.Thread(target=drip, args=(writer, head, stop, 0.2), daemon=True)
    dripper.start()
    try:
        budget = 0.5
        started = time.monotonic()
        html = detect.fetch_html('https://shop.example.com/p', opener=SocketOpener(reader), timeout=2,
                                 budget_s=budget)
        elapsed = time.monotonic() - started
        assert html is None
        assert elapsed < budget + 1
        if head is BODY_DRIP:
            assert wait_until(lambda: not fetch_threads_alive(), 2), 'the reader must stop at its own deadline'
            assert dripper.is_alive()
    finally:
        stop.set()
        dripper.join(5)
        writer.close()
        assert wait_until(lambda: not fetch_threads_alive(), 5)
        reader.close()
    assert detect.FETCH_BUDGET_S == 45


def test_fetch_html_refuses_non_https():
    opener = FakeOpener(FakeResponse(b'<html></html>'))
    assert detect.fetch_html('http://shop.example.com/p', opener=opener) is None
    assert opener.requests == []


LINK = 'https://shop.example.com/products/family-ornament'


@pytest.mark.parametrize('page, word', [('customily.html', 'customily'), ('customall.html', 'customall'),
                                        ('teeinblue.html', 'teeinblue'), ('customix.html', 'customix'),
                                        ('globo.html', 'unsupported:globo'), ('plain.html', 'unknown')])
def test_command_line_prints_one_word_for_the_page(capsys, page, word):
    opener = FakeOpener(FakeResponse(fixture(page).encode('utf-8')))
    assert detect.main(['--url', LINK], opener=opener) == 0
    assert capsys.readouterr().out == word + '\n'
    assert [req.full_url for req, _ in opener.requests] == [LINK]


@pytest.mark.parametrize('outcome', [urllib.error.URLError('down'), FakeResponse(b'<html></html>', status=203),
                                     TimeoutError('slow')])
def test_command_line_says_unknown_when_the_page_does_not_load(capsys, outcome):
    assert detect.main(['--url', LINK], opener=FakeOpener(outcome)) == 0
    assert capsys.readouterr().out == 'unknown\n'


def test_command_line_never_fetches_a_non_https_link(capsys):
    opener = FakeOpener(FakeResponse(fixture('customily.html').encode('utf-8')))
    assert detect.main(['--url', 'http://shop.example.com/products/a'], opener=opener) == 0
    assert capsys.readouterr().out == 'unknown\n' and opener.requests == []


def test_command_line_help_exits_0():
    done = subprocess.run([sys.executable, detect.__file__, '--help'], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and '--url' in done.stdout


def test_redirects_only_to_https():
    handler = detect.HttpsOnlyRedirect()
    req = urllib.request.Request('https://shop.example.com/a')
    assert handler.redirect_request(req, None, 302, 'Found', {}, 'http://shop.example.com/b') is None
    follow = handler.redirect_request(req, None, 302, 'Found', {}, 'https://shop.example.com/b')
    assert follow is not None and follow.full_url == 'https://shop.example.com/b'
