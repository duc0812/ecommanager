#!/usr/bin/env python3
"""Backfill SpyAd.mediaUrl from stored rawPayload. Idempotent; only fills NULL mediaUrl.
Run from the project root (where dev.db and DATABASE_URL resolve): python3 scripts/backfill-ad-media.py
"""
import sqlite3, json, sys, os

DB = os.environ.get("SPY_DB", "dev.db")

def extract_media(snapshot):
    if not isinstance(snapshot, dict):
        return None
    videos = snapshot.get("videos") or []
    if videos and videos[0].get("video_preview_image_url"):
        return videos[0]["video_preview_image_url"]
    images = snapshot.get("images") or []
    if images and images[0].get("resized_image_url"):
        return images[0]["resized_image_url"]
    if images and images[0].get("original_image_url"):
        return images[0]["original_image_url"]
    cards = snapshot.get("cards") or []
    if cards:
        c = cards[0]
        return c.get("resized_image_url") or c.get("video_preview_image_url") or c.get("original_image_url")
    return None

def main():
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT id, rawPayload FROM SpyAd WHERE mediaUrl IS NULL AND rawPayload IS NOT NULL").fetchall()
    filled = 0
    for ad_id, raw in rows:
        try:
            snap = (json.loads(raw) or {}).get("snapshot") or {}
        except Exception:
            continue
        url = extract_media(snap)
        if url:
            conn.execute("UPDATE SpyAd SET mediaUrl = ? WHERE id = ?", (url, ad_id))
            filled += 1
    conn.commit()
    print(f"scanned={len(rows)} filled={filled}")

if __name__ == "__main__":
    main()
