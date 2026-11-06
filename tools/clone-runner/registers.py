"""Finds a source link in the registers the Litzzy clone tools kept before the queue existed (decision 15 of the spec).

Each register entry is `<root>\\<slug>\\clone.json` with `source`, `product` (gid), `handle` and `status`. Only an
ACTIVE entry counts, and never the job's own (slug = its SKU code in lower case): a retried job must not take its
earlier attempt for an old product. Slug shape cannot tell queue entries apart, since the owner's own clones use
design codes of the same shape (dn0411261016). The Reminiso tools keep no register, so other stores find nothing.
"""
from __future__ import annotations

import glob
import json
import os
import re
import urllib.parse

REGISTER_ROOTS = {'LIT': (r'D:\Ecom manager\clipart-clones', r'D:\Ecom manager\customall-clones')}
GID_RE = re.compile(r'^gid://shopify/Product/\d+$', re.ASCII)
DEFAULT_PORTS = {'http': 80, 'https': 443}


def source_key(url) -> str | None:
    """The server's `sourceKeyOf`: lower-cased host (with a non-default port) + path, without query, hash or
    trailing slashes."""
    if not isinstance(url, str):
        return None
    try:
        parts = urllib.parse.urlsplit(url.strip())
        host, port = parts.hostname, parts.port
    except ValueError:
        return None
    if not host:
        return None
    if port is not None and port != DEFAULT_PORTS.get(parts.scheme):
        host = f'{host}:{port}'
    return host + parts.path.rstrip('/')


def _entries(root: str):
    for path in sorted(glob.glob(os.path.join(glob.escape(root), '*', 'clone.json'))):
        try:
            with open(path, encoding='utf-8-sig') as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            yield os.path.basename(os.path.dirname(path)), data


def find_existing(job: dict, roots=None) -> dict | None:
    store = job.get('store') if isinstance(job.get('store'), dict) else {}
    defaults = REGISTER_ROOTS.get(store.get('orderPrefix'))
    key = source_key(job.get('sourceUrl'))
    own = job.get('skuCode').lower() if isinstance(job.get('skuCode'), str) else None
    if defaults is None or key is None:
        return None
    for root in defaults if roots is None else roots:
        for folder, data in _entries(root):
            if own and own in (folder.lower(), str(data.get('slug')).lower()):
                continue
            gid, handle = data.get('product'), data.get('handle')
            if data.get('status') != 'ACTIVE' or source_key(data.get('source')) != key:
                continue
            if not isinstance(gid, str) or not GID_RE.fullmatch(gid):
                continue
            return {'productGid': gid, 'handle': handle if isinstance(handle, str) and handle else None}
    return None
