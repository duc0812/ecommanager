"""Make 2000 px JPEG previews for print files Google will not resize (over ~40 MB), from this PC.

Google serves a resized copy of a shared Drive image only up to ~40 MB; bigger prints have no small picture, so the
tool pulled the original (60-170 MB) through the server at ~265 KB/s. This script downloads each such file through a
local dev server (which reads Drive at full speed), resizes it with Pillow and writes <out>/<artworkId>.jpg plus a
ledger. The JPEGs then go to the server's storage/design/_previews/ and DesignArtwork.previewPath is set (see the
--apply-sql output), the same place the browser-made previews land after upload.

  python scripts/backfill-artwork-previews.py --list big-prints.json --out previews --base http://localhost:3014 \
      --login preview-login.txt

big-prints.json: [{id, driveFileId, size, w, h, mime, part}] from DesignArtwork (storage DRIVE, previewPath NULL).
"""
import argparse, io, json, os, sys, time, urllib.request, urllib.error
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
MAX_PX = 2000


def login(base, path):
    email, password = [l.strip() for l in open(path, encoding='utf-8').read().splitlines()[:2]]
    req = urllib.request.Request(f'{base}/api/auth/login', data=json.dumps({'email': email, 'password': password}).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as res:
        cookie = res.headers.get('Set-Cookie', '').split(';')[0]
    if not cookie:
        sys.exit('login gave no cookie')
    return cookie


def download(base, cookie, row):
    req = urllib.request.Request(f"{base}/api/design-studio/file/{row['id']}", headers={'Cookie': cookie})
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            return res.read(), 'app'
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"  app download failed ({e}); trying Google directly", flush=True)
    url = f"https://drive.usercontent.google.com/download?id={row['driveFileId']}&export=download&confirm=t"
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=1800) as res:
        return res.read(), 'google'


def preview(data):
    im = Image.open(io.BytesIO(data))
    im.draft('RGB', (MAX_PX, MAX_PX))
    im.load()
    if im.mode in ('RGBA', 'LA', 'P'):
        im = im.convert('RGBA')
        bg = Image.new('RGB', im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    elif im.mode != 'RGB':
        im = im.convert('RGB')
    im.thumbnail((MAX_PX, MAX_PX), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'JPEG', quality=85, optimize=True)
    return out.getvalue(), im.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--base', default='http://localhost:3014')
    ap.add_argument('--login', required=True)
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    rows = json.load(open(a.list, encoding='utf-8'))
    if a.limit:
        rows = rows[:a.limit]
    os.makedirs(a.out, exist_ok=True)
    ledger_path = os.path.join(a.out, 'ledger.json')
    ledger = json.load(open(ledger_path, encoding='utf-8')) if os.path.exists(ledger_path) else {}
    cookie = login(a.base, a.login)
    t0 = time.time()
    for i, row in enumerate(rows, 1):
        if ledger.get(row['id'], {}).get('ok'):
            continue
        dst = os.path.join(a.out, f"{row['id']}.jpg")
        print(f"[{i}/{len(rows)}] {row['id']} {row['part']} {row['size'] / 1e6:.0f} MB {row['w']}x{row['h']}", flush=True)
        try:
            t = time.time()
            data, via = download(a.base, cookie, row)
            dl = time.time() - t
            jpeg, size = preview(data)
            with open(dst, 'wb') as f:
                f.write(jpeg)
            ledger[row['id']] = {'ok': True, 'via': via, 'bytes': len(jpeg), 'px': size, 'src_bytes': len(data)}
            print(f"  ok via {via} in {dl:.0f}s -> {len(jpeg) / 1024:.0f} KB {size[0]}x{size[1]}", flush=True)
        except Exception as e:
            ledger[row['id']] = {'ok': False, 'error': str(e)}
            print(f"  FAILED: {e}", flush=True)
        json.dump(ledger, open(ledger_path, 'w', encoding='utf-8'), indent=1)
    done = sum(1 for v in ledger.values() if v.get('ok'))
    print(f"done: {done}/{len(rows)} previews in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == '__main__':
    main()
