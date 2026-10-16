# Artwork Library worker

Runs on the design PC. It claims two kinds of jobs from Ecom Manager:
- `PARSE_PSD`: reads each PSD **once** (custom text fields, fixed texts, `artwork.png` with the custom text hidden,
  `preview.png`) and uploads the result.
- `RENDER_LINE`: the per-order step. It draws one order line's customer values onto the entry's `artwork.png` and
  uploads the print file (see "Print files" below). Spec: `docs/superpowers/specs/2026-10-11-artwork-library-design.md`.

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

### Daily auto-render (07:00)

`run-daily.ps1` runs `worker.py --auto-render --drain` against prod from the Windows Task Scheduler task
"EcomManager Auto Render" (daily 07:00, runs as soon as the PC is on if 07:00 was missed). `--auto-render` asks the
server to queue a `RENDER_LINE` job for every task still NEW/ASSIGNED whose product has a READY artwork for its template
and whose customer filled every field; `--drain` works the queue and exits. A line is tried once: a line that already
has a print file or an earlier render job is left to the designer. Rendered tasks go to REVIEW as usual.

- Token: create it in Design Studio > Settings on prod, then run `.\set-token.ps1` and paste it at the prompt.
  It is saved to `%USERPROFILE%\.artwork-worker\prod.env`.
- Logs: `%USERPROFILE%\.artwork-worker\logs\auto-render-<date>.log`, kept 30 days.

The worker never prints the token. Exit codes: `0` ok or no job, `1` the server can't be reached or rejects the token, `2` env missing.

Files:
- Fonts are cached by content hash in `~/.artwork-worker/fonts/<sha256>`; set `ARTWORK_WORKER_HOME` to move the cache.
- Each PSD goes to a temp folder that is deleted after the job, whether the job succeeds or fails.

## Layer convention (for designers)

- Name each custom text layer `@Tên trường`, for example `@Custom Name`. The field is whatever comes after `@`. A trailing Photoshop ` copy` / ` copy 2` is ignored.
- Every other **visible** text layer is fixed text. It stays in `artwork.png` as Photoshop drew it.
- Use **paragraph (box) text** to set how wide a name may run. The box width becomes the field width, clipped to the canvas, and longer names shrink to fit it. With point text, the field width is just the sample's width; widen it in the UI.
- A PSD without `@` names still works: pick each text layer's field on the product page ("Chữ cố định" / "Trường khách: …"). The choice is stored as the entry's `layerFields` and passed to the parser as `custom_layers`; `@` layers keep working alongside it.
- **Placements:** layers of the same field whose boxes do **not** overlap are separate placements, and the customer's value is drawn at each one (e.g. a tumbler with the name on both sides: two `@Custom Name` layers). Each placement is its own entry in `fields` with the same `field` name.
- Layers of the same field that **overlap** form one placement. Only the top visible layer is drawn; the layers below it add effects:
  - a layer with a Drop Shadow gives the field's `shadow`;
  - a plain copy at an offset (the "3D" look) gives a hard shadow: `dx/dy` = the offset, `blur 0`, in that copy's colour;
  - a layer with a Stroke gives the field's `stroke`;
  - an identical duplicate is ignored;
  - anything else becomes a warning.
- Hidden layers are ignored. If every layer of a field is hidden, the top one is used and a warning is added.

## Print files (`RENDER_LINE`)

- A designer presses **"Tạo file in tự động"** on the task. The button works when the line's library entry is READY,
  the template has a print area, and the customer filled every field the entry uses.
- The claim carries the entry fields, the template, the `artwork.png` file id (cached by hash in
  `~/.artwork-worker/artwork/`), the fonts, the customer values and the target line.
- `render_line.py` draws each field entry with its customer value, so a field placed twice gets the value twice.
  - `fit: shrink` keeps long values inside the box, and `anchor: center` keeps the sample's visual centre.
  - Missing glyphs and values shrunk below 60 % come back as warnings.
- The result is a PNG at template px with the template DPI and an sRGB ICC profile, plus a ≤ 1200 px JPG preview.
- The server stores it as a new `DesignArtwork` version on the template's first print area with `source AUTO`, and
  tries the Drive push like a manual upload. The task is not approved automatically; the designer or leader reviews it.
- A missing value, font or artwork fails the job at once (`permanent`). Other errors are retried, 3 attempts in all.
  The error shows on the task.

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
| `gradient` | Gradient Overlay (linear only): angle, scale, offset, align with layer, reverse, opacity, colour stops (location 0-1, colour, midpoint of the segment ending at the stop), opacity stops, interpolation method (`gs99`: Perceptual → Oklab, Linear → linear light, Classic → sRGB + smoothness) |
| `bevel` | Bevel & Emboss, inner bevel only: technique (Smooth / Chisel Hard / Chisel Soft), depth, direction, size, soften, angle/altitude (global light resolved), gloss contour points, highlight/shadow colour, opacity and blend mode |
| `tracking` (fitted) | Photoshop spaces glyphs a little differently from Pillow. The parser renders the sample at tracking −60…+60 around the PSD value and keeps the one whose mask best overlaps the layer's own pixels (IoU), when it gains ≥ 0.01. `diagnostics.trackingFit` records it |
| `box` | horizontal extent: paragraph box (clipped) or ink bbox. Height: font line height. Then the box is moved so our render lines up with the layer's own pixels (FFT cross-correlation of the masks) |
| `anchor` / `fit` | `center` / `shrink` defaults; the UI edits them |

Effects sizes are used as stored. The `Scl` (effects scale) value in `lfx2` is **not** applied: on the HaPo tumbler (Scl 416 %) and the crocs strap, Photoshop draws the shadow, stroke and bevel at the stored pixel sizes.

How the styles are drawn (`textrender.py`), in Photoshop's order (shadow, stroke, fill, gradient, bevel):
- Gradient: `t = 0.5 + ((p − c)·d) / L`, `d = (cos θ, −sin θ)`, `c` = reference-box centre + offset % of the box, `L = (|w cos θ| + |h sin θ|) × scale`. The reference box is the text's ink bbox (align with layer) or `frame`. Colours come from a 2048-entry LUT; inside a segment the midpoint is piecewise-linear.
- Bevel: height = distance to the edge (on a 4× supersampled mask) ÷ size, clipped to 1 (chisel), or a blurred mask (smooth), blurred by `soften`, negated for direction down, scaled by size × depth. Lambert shading with the light at angle/altitude is passed through the gloss contour and compared with `sin(altitude)`: above → highlight, below → shadow, each drawn with its colour, opacity and blend mode inside the fill.
- Fitted on the HaPo tumbler (gold "Harry", Ring contour): check score 4.9 against Photoshop's composite.

Extra keys beyond the spec shape: `scaleX`, `charColors`, `layers`, `shadow.spread`, `gradient`, `bevel`. `textrender.py` reads all of them. `result.json` also carries `diagnostics` (PSD vs render ink sizes, correlation shift) and `fonts`.

## API shapes (see `api.py`, mirrors `src/lib/artwork-worker.ts`)

- `POST /api/design-studio/worker/claim` with `{"kinds": ["PARSE_PSD", "RENDER_LINE"]}` (no body = PARSE_PSD only) → returns one of:
  - `{job: null}`;
  - `{job:{id,kind,attempts,createdAt}, entry:{id,storeId,shopifyProductId,title,status,fields,layerFields}, template:{id,name,widthPx,heightPx,dpi,bleedIn,safeIn,mirror,areas:[{name,x,y,w,h}]}, psdFileId, psd:{id,fileName,size,sha256}}`;
  - for `RENDER_LINE`: `{job, entry:{id,…,fields}, template, artwork:{id,fileName,size,sha256}, fonts:[{postscriptName,fileId,sha256}], values:{field: value}, target:{orderId,shopifyLineId,orderNumber,linePosition,taskKey,printArea}}`.
- `GET worker/files/<id>` → file bytes. The download is checked against `psd.sha256`, or the `X-Content-SHA256` header when there is no `psd.sha256`.
- `GET worker/fonts` → `{fonts:[{postscriptName,fileId,sha256,family,style,fileName,size}]}`.
- `POST worker/jobs/<id>/result` → multipart parts `result` (`result.json`), `artwork` (`artwork.png`), `preview` (`preview.png`). The server computes the final status from fields, missingFonts, warnings and checkScore.
  - For `RENDER_LINE` the parts are `result` (`{fields, warnings, widthPx, heightPx}`), `print` (`print.png`) and `preview` (`preview.jpg`).
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
  - inner/outer glow, inner shadow, satin, pattern overlays;
  - bevel styles other than inner bevel, bevel texture, non-linear gradients;
  - layers clipped to custom text.
- `artwork.png` is composited by psd-tools, which does not draw drop shadows or some smart-object effects exactly like Photoshop. The check compares against Photoshop's embedded composite, so differences near fields lower the score.
