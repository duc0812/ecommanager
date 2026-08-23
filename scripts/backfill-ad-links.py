#!/usr/bin/env python3
"""Backfill SpyAd.resolvedUrl by following short/coded landing links to their final URL.

Ads whose linkUrl is a coded redirect (e.g. https://store.com/CT6082038) never parse as a
product, so they get no "uploaded" date. This follows the redirect once and stores the final
/products/<handle> URL in resolvedUrl, which the ads API then uses for matching.

Idempotent: only looks at rows where linkResolvedAt IS NULL, and stamps linkResolvedAt on
every row it checks (resolved or not) so re-runs skip them. DateTime is written as ISO-8601
text to match the Prisma/libsql storage format.

Run from the project root (where dev.db resolves): python3 scripts/backfill-ad-links.py
"""
import sqlite3, os
from urllib.parse import urlparse, parse_qs, unquote
from urllib.request import Request, urlopen
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

DB = os.environ.get("SPY_DB", "dev.db")
UA = "Mozilla/5.0 (compatible; EcomManagerBot/1.0)"
TIMEOUT = 8
WORKERS = 8


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
            return resp.geturl()
    except Exception:
        return None


def main():
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        "SELECT id, linkUrl FROM SpyAd WHERE linkResolvedAt IS NULL AND linkUrl IS NOT NULL"
    ).fetchall()
    to_resolve = [(i, u) for (i, u) in rows if needs_resolution(u)]
    to_mark = [i for (i, u) in rows if not needs_resolution(u)]

    if to_mark:
        ts = now_iso()
        conn.executemany("UPDATE SpyAd SET linkResolvedAt=? WHERE id=?", [(ts, i) for i in to_mark])
        conn.commit()

    resolved = 0

    def work(item):
        _id, url = item
        return _id, url, resolve(url)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for _id, url, final in ex.map(work, to_resolve):
            good = final if (final and final != url) else None
            conn.execute("UPDATE SpyAd SET resolvedUrl=?, linkResolvedAt=? WHERE id=?", (good, now_iso(), _id))
            if good:
                resolved += 1
    conn.commit()
    print(f"checked={len(rows)} needing={len(to_resolve)} marked={len(to_mark)} resolved={resolved}")


if __name__ == "__main__":
    main()
