#!/usr/bin/env python3
"""Prune "junk" spy ads: fanpages (advertisers) that never link to a saved domain.

A fanpage (SpyAdvertiser) is JUNK when NONE of its ads' landing URLs (resolvedUrl or
linkUrl, with l.facebook.com unwrapped) point at a saved domain — the union of
SpyStore.domain and SpyAdDomain.domain. These are unrelated advertisers pulled in by
broad Apify searches (e.g. a "family store" search matching familystore.gr / .ge / .sbs).

Deletes, in FK-safe order (children first): SpyAdObservation, SpyKeywordHit, SpyAd,
then the junk fanpages' SpyPageTarget (so they are not re-scanned) and SpyAdvertiser
rows. Saved Ideas (SpyIdea.refAdId) are preserved; any referencing a pruned ad are
reported. A whole fanpage is kept if it has even one ad landing on a saved domain.

DRY RUN by default. Guards: aborts if there are no saved domains, or if the prune would
remove >80% of ads (unless FORCE=1).

  python3 scripts/prune-nonsaved-ads.py             # dry run (preview)
  CONFIRM=1 python3 scripts/prune-nonsaved-ads.py   # execute
"""
import sqlite3, os
from urllib.parse import urlparse, parse_qs, unquote
from collections import defaultdict

DB = os.environ.get("SPY_DB", "dev.db")


def bare(s):
    s = (s or '').strip().lower().replace('https://', '').replace('http://', '').split('/')[0]
    return s[4:] if s.startswith('www.') else s


def host_of(url):
    if not url:
        return ''
    try:
        u = urlparse(url if '://' in url else 'http://' + url)
    except Exception:
        return ''
    h = (u.hostname or '').lower()
    if h in ('l.facebook.com', 'lm.facebook.com'):
        q = parse_qs(u.query).get('u')
        if q:
            return host_of(unquote(q[0]))
    return h[4:] if h.startswith('www.') else h


def chunked(seq, n=400):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def main():
    conn = sqlite3.connect(DB)
    saved = set()
    for (d,) in conn.execute("SELECT domain FROM SpyStore"):
        b = bare(d)
        if b:
            saved.add(b)
    for (d,) in conn.execute("SELECT domain FROM SpyAdDomain"):
        b = bare(d)
        if b:
            saved.add(b)
    if not saved:
        print("No saved domains found — aborting (refusing to prune everything).")
        return

    rows = conn.execute("""SELECT ad.id, adv.id, adv.fbPageId, adv.pageName, ad.linkUrl, ad.resolvedUrl
                           FROM SpyAd ad JOIN SpyAdvertiser adv ON adv.id=ad.advertiserId""").fetchall()
    ads_by_adv = defaultdict(list)
    saved_hits = defaultdict(int)
    meta = {}
    for adid, advid, fb, pn, link, res in rows:
        ads_by_adv[advid].append(adid)
        meta[advid] = (fb, pn)
        if host_of(res or link) in saved:
            saved_hits[advid] += 1

    junk_adv = [a for a in ads_by_adv if saved_hits[a] == 0]
    junk_ads = [adid for a in junk_adv for adid in ads_by_adv[a]]
    junk_fb = [meta[a][0] for a in junk_adv if meta[a][0]]

    print("saved domains:", sorted(saved))
    print("advertisers: total=%d junk=%d" % (len(ads_by_adv), len(junk_adv)))
    for a in sorted(junk_adv, key=lambda x: -len(ads_by_adv[x])):
        print("  JUNK %-18s fb=%-18s ads=%d" % (str(meta[a][1])[:18], meta[a][0], len(ads_by_adv[a])))
    print("ads to delete: %d  | ads kept: %d" % (len(junk_ads), len(rows) - len(junk_ads)))

    ideas_hit = 0
    for ch in chunked(junk_ads):
        qm = ",".join("?" * len(ch))
        ideas_hit += conn.execute("SELECT COUNT(*) FROM SpyIdea WHERE refAdId IN (%s)" % qm, ch).fetchone()[0]
    print("saved Ideas referencing a pruned ad (kept, snapshot retained):", ideas_hit)

    if rows and len(junk_ads) > 0.8 * len(rows) and os.environ.get("FORCE") != "1":
        print("\nAbort: prune would remove >80%% of ads (%d/%d). Set FORCE=1 if intended." % (len(junk_ads), len(rows)))
        return

    if not junk_ads:
        print("\nNothing to prune.")
        return

    if os.environ.get("CONFIRM") != "1":
        print("\nDRY RUN — set CONFIRM=1 to delete.")
        return

    try:
        obs = kw = dads = dpt = dadv = 0
        for ch in chunked(junk_ads):
            qm = ",".join("?" * len(ch))
            obs += conn.execute("DELETE FROM SpyAdObservation WHERE adId IN (%s)" % qm, ch).rowcount
            kw += conn.execute("DELETE FROM SpyKeywordHit WHERE adId IN (%s)" % qm, ch).rowcount
        for ch in chunked(junk_ads):
            qm = ",".join("?" * len(ch))
            dads += conn.execute("DELETE FROM SpyAd WHERE id IN (%s)" % qm, ch).rowcount
        for ch in chunked(junk_fb):
            qm = ",".join("?" * len(ch))
            dpt += conn.execute("DELETE FROM SpyPageTarget WHERE fbPageId IN (%s)" % qm, ch).rowcount
        for ch in chunked(junk_adv):
            qm = ",".join("?" * len(ch))
            dadv += conn.execute("DELETE FROM SpyAdvertiser WHERE id IN (%s)" % qm, ch).rowcount
        conn.commit()
        print("\nDELETED: observations=%d keywordHits=%d ads=%d pageTargets=%d advertisers=%d"
              % (obs, kw, dads, dpt, dadv))
    except Exception as e:
        conn.rollback()
        print("ERROR, rolled back:", e)
        raise


if __name__ == "__main__":
    main()
