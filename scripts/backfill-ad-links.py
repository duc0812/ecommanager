#!/usr/bin/env python3
"""Backfill SpyAd.resolvedUrl by following short/coded landing links to their final URL.

Ads whose linkUrl is a coded redirect (e.g. https://store.com/CT6082038) never parse as a
product, so they get no "uploaded" date. This follows the redirect once and stores the final
/products/<handle> URL in resolvedUrl, which the ads API then uses for matching.

Each attempt is classified: ok (stamp resolvedUrl + linkResolvedAt), dead (4xx -> stamp
linkResolvedAt only, never retry), or retry (timeout / 429 / 5xx -> left untouched so a later
run picks it up). This is why bursts that get throttled recover on a re-run.

Modes:
  python3 scripts/backfill-ad-links.py            # process rows never attempted (linkResolvedAt IS NULL)
  SPY_RETRY=1 python3 scripts/backfill-ad-links.py # re-open every unresolved row, then process

DateTime is written as ISO-8601 text to match the Prisma/libsql storage format.
Run from the project root (where dev.db resolves).
"""
import sqlite3, os
from urllib.parse import urlparse, parse_qs, unquote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

DB = os.environ.get("SPY_DB", "dev.db")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = 8
WORKERS = int(os.environ.get("SPY_WORKERS", "4"))
DEAD = {400, 401, 403, 404, 405, 410, 451}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def unwrap(url):
    try:
        u = urlparse(url)
    except Exception:
        return url
    if u.hostname and u.hostname.lower() in ("l.facebook.com", "lm.facebook.com"):
        q = parse_qs(u.query).get("u")
        if q:
            return unwrap(unquote(q[0]))
    return url


def needs_resolution(url):
    if not url:
        return False
    try:
        u = urlparse(unwrap(url))
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    path = u.path or ""
    if path in ("", "/"):
        return False
    if "/products/" in path or "/collections/" in path:
        return False
    return True


def resolve(url):
    try:
        req = Request(url, method="GET", headers={"User-Agent": UA})
        with urlopen(req, timeout=TIMEOUT) as resp:
            return ("ok", resp.geturl())
    except HTTPError as e:
        return ("dead", None) if e.code in DEAD else ("retry", None)
    except Exception:
        return ("retry", None)


def main():
    conn = sqlite3.connect(DB)
    if os.environ.get("SPY_RETRY") == "1":
        conn.execute("UPDATE SpyAd SET linkResolvedAt=NULL WHERE resolvedUrl IS NULL")
        conn.commit()

    rows = conn.execute(
        "SELECT id, linkUrl FROM SpyAd WHERE linkResolvedAt IS NULL AND linkUrl IS NOT NULL"
    ).fetchall()
    to_resolve = [(i, u) for (i, u) in rows if needs_resolution(u)]
    to_mark = [i for (i, u) in rows if not needs_resolution(u)]

    if to_mark:
        ts = now_iso()
        conn.executemany("UPDATE SpyAd SET linkResolvedAt=? WHERE id=?", [(ts, i) for i in to_mark])
        conn.commit()

    resolved = dead = retried = 0

    def work(item):
        _id, url = item
        return _id, url, resolve(url)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for _id, url, (status, final) in ex.map(work, to_resolve):
            if status == "retry":
                retried += 1
                continue
            if status == "dead":
                conn.execute("UPDATE SpyAd SET linkResolvedAt=? WHERE id=?", (now_iso(), _id))
                dead += 1
                continue
            good = final if (final and final != url) else None
            conn.execute("UPDATE SpyAd SET resolvedUrl=?, linkResolvedAt=? WHERE id=?", (good, now_iso(), _id))
            if good:
                resolved += 1
    conn.commit()
    print(f"checked={len(rows)} needing={len(to_resolve)} marked={len(to_mark)} "
          f"resolved={resolved} dead={dead} retry_left={retried}")


if __name__ == "__main__":
    main()
