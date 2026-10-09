# Artwork Library parse worker

Runs on the design PC. It claims `PARSE_PSD` jobs from Ecom Manager and reads each PSD **once**:
custom text fields, fixed texts, `artwork.png` (custom text hidden) and `preview.png`. It then uploads
the result. Spec: `docs/superpowers/specs/2026-10-11-artwork-library-design.md`.

## Setup

```powershell
cd tools\artwork-worker
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

`psd-tools[composite]` pulls in scipy, which psd-tools needs to composite stroke effects.

## Run

```powershell
$env:ECOM_URL = "http://localhost:3002"            # or the prod URL
$env:DESIGN_WORKER_TOKEN = "dsw_..."               # Design Studio > Settings (SUPERADMIN), shown once
.venv\Scripts\python worker.py --once              # one job if queued, then exit
.venv\Scripts\python worker.py --poll 10           # loop; sleep 10 s while the queue is empty
.venv\Scripts\python worker.py --once --debug-dir C:\tmp\aw   # also keep reference.png / check.png
```

The worker never prints the token. Exit codes: `0` ok or no job, `1` the server can't be reached or rejects the token, `2` env missing.

Files:
- Fonts are cached by content hash in `~/.artwork-worker/fonts/<sha256>`; set `ARTWORK_WORKER_HOME` to move the cache.
- Each PSD goes to a temp folder that is deleted after the job, whether the job succeeds or fails.

## Layer convention (for designers)

- Name each custom text layer `@Tên trường`, for example `@Custom Name`. The field is whatever comes after `@`. A trailing Photoshop ` copy` / ` copy 2` is ignored.
- Every other **visible** text layer is fixed text. It stays in `artwork.png` as Photoshop drew it.
- Use **paragraph (box) text** to set how wide a name may run. The box width becomes the field width, clipped to the canvas, and longer names shrink to fit it. With point text, the field width is just the sample's width; widen it in the UI.
- You can give one field several layers by naming them the same, for example `@Name` plus a shadow copy `@Name copy`. Only the top visible layer is drawn; the layers below it add effects:
  - a layer with a Drop Shadow gives the field's `shadow`;
  - a plain copy at an offset (the "3D" look) gives a hard shadow: `dx/dy` = the offset, `blur 0`, in that copy's colour;
  - a layer with a Stroke gives the field's `stroke`;
  - an identical duplicate is ignored;
  - anything else becomes a warning.
- Hidden layers are ignored. If every layer of a field is hidden, the top one is used and a warning is added.

## Result statuses

- **NEEDS_FONTS**: a field's font (PostScript name) is not in the library. Upload it on the Fonts page; the server requeues the entry. The artwork and fields are still uploaded, but there is no check score.
- **NEEDS_REVIEW**: one or more of:
  - the PSD has warnings: warped or rotated text, faux bold/italic, an unsupported layer style, layer opacity, a PSD size that differs from the template, no `@` layers, …;
  - `checkScore` > 6.

  Compare our render with the PSD composite and press "Xác nhận dùng".
- **READY**: all fonts are present, there are no warnings, and `checkScore` ≤ 6.

`checkScore` measures the mean absolute difference (0–255) between two images over the union of the field boxes plus their effect margins, at 1/8 scale:
- `artwork.png` with each field's sample drawn by `textrender.py`;
- the PSD composite, which is Photoshop's embedded composite when the PSD has one.

## How values are derived

All values are in template px. When the PSD size differs from the template but the aspect ratio is within 1%, everything is scaled. A larger aspect mismatch fails the job as permanent.

| field key | source |
|---|---|
| `font` | `FontSet[StyleSheet.Font]` of the first non-space character |
| `sizePx` | `FontSize × |vertical axis of layer.transform| × VerticalScale` (the transform scale is not applied twice) |
| `scaleX` | horizontal ÷ vertical transform scale (× HorizontalScale); only when ≠ 1 |
| `color` / `charColors` | engine `FillColor` (ARGB floats 0–1) per character; `charColors` only when the colours differ (cycled over non-space characters). A 100 % normal Color Overlay replaces them |
| `align` | ParagraphRun `Justification` 0 left · 1 right · 2 center (3–6 → their last-line alignment) |
| `tracking` | Photoshop units (1/1000 em) |
| `leading` | px between baselines (Auto leading = 1.2 × size) |
| `stroke` | layer style Stroke: outside = size, center = size/2, inside → warning |
| `shadow` | Drop Shadow: `dx = -cos(angle)·distance`, `dy = sin(angle)·distance` (global light resolved), `blur` = size, `opacity` 0–1, `spread` = choke % |
| `box` | horizontal extent: paragraph box (clipped) or ink bbox. Height: font line height. Then the box is moved so our render lines up with the layer's own pixels (FFT cross-correlation of the masks) |
| `anchor` / `fit` | `center` / `shrink` defaults; the UI edits them |

Extra keys beyond the spec shape: `scaleX`, `charColors`, `layers`, `shadow.spread`. `textrender.py` reads all of them. `result.json` also carries `diagnostics` (PSD vs render ink sizes, correlation shift) and `fonts`.

## API shapes (see `api.py`, mirrors `src/lib/artwork-worker.ts`)

- `POST /api/design-studio/worker/claim` → returns one of:
  - `{job: null}`;
  - `{job:{id,kind,attempts,createdAt}, entry:{id,storeId,shopifyProductId,title,status,fields}, template:{id,name,widthPx,heightPx,dpi,bleedIn,safeIn,mirror,areas:[{name,x,y,w,h}]}, psdFileId, psd:{id,fileName,size,sha256}}`.
- `GET worker/files/<id>` → file bytes. The download is checked against `psd.sha256`, or the `X-Content-SHA256` header when there is no `psd.sha256`.
- `GET worker/fonts` → `{fonts:[{postscriptName,fileId,sha256,family,style,fileName,size}]}`.
- `POST worker/jobs/<id>/result` → multipart parts `result` (`result.json`), `artwork` (`artwork.png`), `preview` (`preview.png`). The server computes the final status from fields, missingFonts, warnings and checkScore.
- `POST worker/jobs/<id>/fail` → `{error, permanent}`.
  - `permanent: true` is used for a ParseError, e.g. an aspect-ratio mismatch.
  - Other errors are retried by the server (3 attempts).

## Tests

```powershell
.venv\Scripts\python -I -m pytest tests -q
```

The tests read real PSDs from `D:\Downloads` / `D:\Downloadn` read-only and skip when the files are missing:
- PSDs without `@` layers use the `custom_layers` override;
- the READY path uses `MyriadPro-Bold` from `C:\Windows\Fonts`.

## Limitations

- Pillow is built without raqm here (BASIC layout): no GPOS kerning, ligatures, contextual script forms or mark positioning. Vietnamese marks that the font builds with GPOS can sit differently from Photoshop.
- Tracking and per-character colours are drawn one glyph at a time, which loses connected script forms.
- Not rendered (each gives a warning):
  - warp / text on path;
  - rotation;
  - vertical text;
  - faux styles;
  - inner/outer glow, bevel, gradient/pattern overlays;
  - layers clipped to custom text.
- `artwork.png` is composited by psd-tools, which does not draw drop shadows or some smart-object effects exactly like Photoshop. The check compares against Photoshop's embedded composite, so differences near fields lower the score.
