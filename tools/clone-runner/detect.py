"""Which personaliser a source product page uses, read from markers in its HTML."""
from __future__ import annotations

import threading
import urllib.parse
import urllib.request

PLATFORMS = ('customily', 'customall', 'teeinblue', 'customix')

CUSTOMILY_MARKERS = ('cdn.customily.com', 'sh.customily.com', 'app.customily.com')
CUSTOMALL_MARKERS = ('apis-v2.customall.io',)
TEEINBLUE_MARKERS = ('sdk.teeinblue.com', 'TeeInBlueProduct')
CUSTOMIX_MARKERS = ('cdn.customix.io',)
GLOBO_MARKERS = ('globosoftware.net', 'globo-product-options', 'class="gpo-', "class='gpo-")
YMQ_MARKERS = ('ymq-option', 'ymq_option', 'cdn.ymq.cool')

MARKERS = (
    ('customily', CUSTOMILY_MARKERS),
    ('customall', CUSTOMALL_MARKERS),
    ('teeinblue', TEEINBLUE_MARKERS),
    ('customix', CUSTOMIX_MARKERS),
    ('unsupported:globo', GLOBO_MARKERS),
    ('unsupported:ymq', YMQ_MARKERS),
)

MAX_BYTES = 3 * 1024 * 1024
FETCH_BUDGET_S = 45
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
              'Chrome/130.0.0.0 Safari/537.36')


def detect_platform(html: str | None) -> str:
    text = (html or '').lower()
    for name, markers in MARKERS:
        if any(m.lower() in text for m in markers):
            return name
    return 'unknown'


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != 'https':
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_html(url: str, opener=None, timeout: int = 30, budget_s: float = FETCH_BUDGET_S) -> str | None:
    if urllib.parse.urlsplit(url or '').scheme != 'https':
        return None
    opener = opener or urllib.request.build_opener(HttpsOnlyRedirect())
    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    box: dict = {}

    def work() -> None:
        try:
            with opener.open(req, timeout=timeout) as resp:
                box['resp'] = resp
                if resp.status != 200:
                    return
                raw = resp.read(MAX_BYTES)
                charset = resp.headers.get_content_charset() or 'utf-8'
            box['html'] = raw.decode(charset, errors='replace')
        except Exception:
            pass

    # `timeout` bounds each socket read only; a server dripping bytes would otherwise hold the runner for ever.
    worker = threading.Thread(target=work, name='fetch-html', daemon=True)
    worker.start()
    worker.join(budget_s)
    if worker.is_alive():
        resp = box.get('resp')
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        return None
    return box.get('html')
