# Hourly Auto Render (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every hour the shop PC renders the open lines with the existing order tooling, checks every custom name against its box and the safe zone, pushes the lines that pass and are labelled AUTO on prod to REVIEW, and holds the rest with a visible reason.

**Architecture:** `run.ps1` starts `auto_render.py`, one Python process that runs the stages in order (mutex → disk → local tool → `process-new-orders.mjs` → name guards → push under `.push-lock` → `/hold` → log + summary). It only *calls* the existing scripts; what they produced is read back from their own files (prod snapshot, local `dev.db`, spec files, push ledgers). `safe_zone.py` holds the geometry, the image measuring and the three guards and knows nothing about the scripts.

**Tech Stack:** Python 3.12.1 (`C:\Program Files\Python312\python.exe`, the `python` on PATH) with Pillow 12.3, numpy 1.26, requests 2.31, pytest 8.3 — all already installed; `sqlite3`, `ctypes` from the stdlib; Windows PowerShell 5.1 for the two `.ps1` files. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-12-designer-agent-design.md` — "Part 1 — Hourly auto render", "Non-goals and anti-goals", "Interface contract" (`POST /hold` only).

## Global Constraints

- The implementer does not run `install-task.ps1` (only its `-PrintOnly` mode), does not push to production, does not run `auto_render.py` against the real config, and does not commit: the coordinator commits. Each task ends by reporting, not by `git commit`.
- Nothing edits, creates or commits a file inside the tool worktree (`TOOL_WORKTREE`) or `artwork-builder\g5`. Their scripts are called; `g5\tools\name_render.py` is imported read-only with `sys.dont_write_bytecode = True` / `PYTHONDONTWRITEBYTECODE=1` so not even a `.pyc` is written there.
- No path of the tool worktree, the main checkout or `artwork-builder` is hard-coded in logic: all come from `%USERPROFILE%\.auto-render\config.env`. A missing script fails the run loudly (exit 2).
- No AI in the run. No approval, no supplier action, no customer contact. Tasks end at REVIEW / AUTO, as the push scripts already do.
- Never a silent run: every stage that could not do its work writes a log line and an `errors` entry and makes the exit code non-zero. "0 lines, exit 0" is only allowed when the stages ran and found nothing.
- All operator-facing text (log lines, summary reasons, `/hold` reasons, README) is Vietnamese; identifiers and JSON keys are English.
- Secrets (`DESIGN_AGENT_TOKEN`, the local login file's password) live only in the env/login files; never in the repo, a log line, the summary, an exception message or a test fixture.
- Tests call nothing real: a fake HTTP server, a fake `node`, a stand-in `name_render.py`, SQLite files and images made in the test (Pillow). TDD: failing test first.
- Exact values: mutex `Local\EcomManagerAutoRenderHourly`; disk floor 30 GB on `D:\`; local tool `http://localhost:3013`, start wait 120 s; `SINCE_DAYS=14`; box tolerance 3 px; `.push-lock` wait up to 30 min, never broken; logs and summaries kept 30 days; task "EcomManager Auto Render Hourly", every hour, 55-minute limit, IgnoreNew, StartWhenAvailable.

## Builder's calls (the design left these open, or could not be followed as written)

Verified against the real scripts and data on 11/12/2026.

1. **`process-new-orders.mjs` gives no machine-readable result.** It is run with `--out <MAIN_CHECKOUT>\db-backups\process-new-orders\auto-<stamp>`; the snapshot path is parsed from its stdout line `snapshot <path>`; `spec-shared.json` and `flat-text.json` are read from the out folder; the locally rendered lines are re-queried from `dev.db` with the script's own selection.
2. **The push scripts exit 0 when they stop or skip** (`DỪNG: …`, "bỏ qua", Drive error). A line counts as pushed only when the script's ledger says `lines[<key>].applied` at a time after the run started.
3. **Worker renders report no ink box** (the render result holds only `sizePx`) and the claim's `noName` is not stored. Used instead: the name's ink = pixel difference between the pushed PNG and the piece's library `artwork.png` (both lossless); `noName` = the `-noname` suffix the server puts in the file name, plus pixel equality with that artwork.
4. **Entries drawn by Photoshop (`artwork-builder\design-rules\*.json`, `renderer: "photoshop"`) cannot be diffed**: the PSD composite differs from `artwork.png` over the whole canvas (measured on LIT6302_1, LIT6295_1, LIT6252_1). For them the designed boxes are the rule's `targets` × `maxW`/`maxH`; the box guard is the renderer's own check (`ps_render.check_report`, 3 px, fails the job); only the safe guard runs here.
5. **Flat-text box guard, read literally, holds approved designs.** Measured with the real `name_render.py`: every glow text throws its halo 150–350 px past its box (128/128), and a `fit: "size"` text (983 of 1,506 texts) keeps one font size so descenders leave the box by up to 122 px. Closest workable rule: the ink box is the **solid** ink (glyphs, stroke, faux bold, arc, rotation; glow halo left out), measured with the renderer's own `render_text` + `place`; for `fit: "size"` the box bounds only the axis the text runs along, the other axis is covered by the safe guard. With that rule, in a sample of 12 specs per text kind, names on three stroke/arc designs (TN2209261813, DN0310260203, TN2209261821) still exceed 3 px by 4–33 px — mostly long names and names with descenders — and are held, as the design intends; every other kind passed. `NAME_BOX_TOLERANCE_PX` (optional config key, default 3) lets the owner widen it.
6. **`flat_text_batch.py` does not say which spec it used.** The spec is found again with a port of its candidate filter; the result is cross-checked against the rendered file sizes; no single match → the line is an error, not pushed.
7. **`minimumCutClearancePx`** exists only inside `sleeveRevision.files[]` (18 specs, per area). It is looked up by area anywhere in the spec.
8. **Prod `PrintTemplate` has no `pieces` column.** Flat-text lines take `safeIn` from the snapshot template of the line's supplier SKU (exact, else longest prefix — as `flat-text-step.mjs`) and the dpi from the spec (default 150); worker lines take template and piece dpi from the local `dev.db`.
9. **cm-builder groups** (files with `path` in `spec-shared.json`) carry customer text nothing here can measure and are not named in the design's step 6: they are not pushed by this run, they are listed under `skipped`.
10. **A held line is held again every hour.** `/hold` is called once per line and reason (`holds.json`); the summary lists it every run.
11. **Disk:** each run's prod snapshot is ~180 MB; the run deletes the snapshot it created (never another one) unless `--keep-snapshot`.
12. **Time budget inside the 55-minute limit:** run deadline 50 min after start; `process-new-orders` is killed at 30 min; the lock wait is 30 min or the time left minus 5 min, whichever is smaller; no push starts with under 3 min left.
13. **Exit codes:** 0 ran to the end (also: previous run still going; lines held), 1 a stage failed, 2 config missing or invalid, 3 disk under the floor.

## Review Focus

1. **Run killed by the task's time limit while it holds `.push-lock`:** the next run frees the lock only if its own marker says it is ours and that process is dead; another holder's lock is never touched. Test in Task 7.
2. **Push script exits 0 without writing the line** (`DỪNG:`, skipped on prod): the line is not reported pushed, the push phase stops, exit 1. Test in Task 7.
3. **The same held line every hour:** one `/hold` call, not 24 notes a day; a changed reason is reported again. Test in Task 7.
4. **Two flat-text specs match one line, or none does:** the line is not pushed and appears under `errors`, never under `pushed` or silently dropped. Test in Task 6.
5. **Library artwork missing on this PC (stored on Drive, not in the worker cache):** the line is pushed with "không kiểm được safe zone" in the summary, not held and not crashed. Test in Task 2.

---

## File structure

| File | Responsibility |
|---|---|
| `tools/auto-render-hourly/safe_zone.py` | rect geometry, lone-"No" rule, ink measuring (pixel diff, renderer), the three guards → `GuardResult` |
| `tools/auto-render-hourly/auto_render.py` | config, mutex, disk, log/summary, local tool, running the scripts, reading their outputs, plan, lock, push, hold, `main` |
| `tools/auto-render-hourly/run.ps1` | entry for Task Scheduler: environment + `python auto_render.py` |
| `tools/auto-render-hourly/install-task.ps1` | registers the task (owner only); `-PrintOnly` shows what it would register |
| `tools/auto-render-hourly/README.md` | setup, config keys, exit codes, what a hold means, unverified items |
| `tools/auto-render-hourly/tests/` | `conftest.py`, `fake_node.py`, `test_safe_zone.py`, `test_worker_guard.py`, `test_flat_guard.py`, `test_foundation.py`, `test_tool_and_process.py`, `test_plan.py`, `test_push.py` |

All tests: `python -m pytest tools/auto-render-hourly/tests -q` from the repo root. `tests/conftest.py` puts the tool folder on `sys.path` (the folder name has a hyphen, it is not a package).

Shared types (defined in Task 1, used everywhere):

```python
Rect = tuple[float, float, float, float]          # x0, y0, x1, y1 in file pixels, x1/y1 exclusive

@dataclass(frozen=True)
class NameBox:                                     # one box the design gives a name
    area: str; field: str; rect: Rect
    check_x: bool = True; check_y: bool = True     # axes on which the box bounds the ink

@dataclass
class GuardResult:
    verdict: str        # 'PASS' | 'HOLD' | 'UNCHECKED' | 'ERROR'
    guard: str | None   # 'NO' | 'BOX' | 'SAFE' | None
    reason: str         # Vietnamese; '' for PASS
    details: dict       # numbers behind the verdict (boxes, ink, overflow px, inset px, ink source)
```

Verdict meaning for the run: `PASS` and `UNCHECKED` are pushed (`UNCHECKED` with its reason in the summary), `HOLD` is held and reported, `ERROR` is not pushed and makes the exit code 1.

Reason texts (exact):

| Case | `guard` | `reason` |
|---|---|---|
| lone No, file carries a name | `NO` | `khách chọn No nhưng file in có tên` |
| ink leaves its box | `BOX` | `tên vượt khung {n} px ({area} · {field})` |
| custom piece with no ink at all | `BOX` | `file dựng không thấy tên ({area})` |
| box or ink inside the safe margin | `SAFE` | `tên chạm safe zone: lấn {n} px vào mép an toàn {inset} px ({area} · {field})` |
| no geometry | — | `không kiểm được safe zone ({why})` |
| measuring failed | — | `không đo được khung tên: {why}` |

`{n}` and `{inset}` are whole pixels, rounded up.

---

### Task 1: `safe_zone.py` — geometry, lone "No", the verdict

**Files:**
- Create: `tools/auto-render-hourly/safe_zone.py`, `tools/auto-render-hourly/tests/conftest.py`
- Test: `tools/auto-render-hourly/tests/test_safe_zone.py`

**Interfaces:**
- Produces: `Rect`, `NameBox`, `GuardResult` (above); `TOLERANCE_PX = 3`
  - `overflow(inner: Rect, outer: Rect, x: bool = True, y: bool = True) -> float` — how far `inner` sticks out of `outer` on the checked axes (≤ 0 = inside)
  - `inset_rect(rect: Rect, px: float) -> Rect`
  - `safe_inset_px(safe_in: float | None, dpi: float | None, min_clearance_px: float | None) -> float | None` — the larger of `safe_in × dpi` and the clearance; `None` when neither can be computed
  - `rotated_bounds(box: dict, rotation: float, pivot: dict | None) -> Rect` — a worker field's `box {x,y,w,h}` turned clockwise by `rotation` degrees around `pivot {x,y}` (default: box centre), as `textrender.canvas_box`
  - `lone_no(pairs: list[tuple[str, str]], fields: tuple[str, ...] = ()) -> bool` — the name switch says No and nothing says Yes. A pair counts as the switch when its key contains `yes or no`, or, lower-cased and stripped of `_`, spaces and trailing `:`/`?`, equals `custom name`, `custom name/text` or one of `fields`
  - `judge(boxes: list[NameBox], inks: list[Rect | None], area: Rect, inset_px: float | None, tol: float = TOLERANCE_PX, box_overflow: float | None = None) -> GuardResult` — order: BOX (pairwise `overflow(ink, box.rect, box.check_x, box.check_y) > tol`, or the given `box_overflow > tol`), then SAFE (any box or ink with `overflow(…, inset_rect(area, inset_px)) > 0`), then `UNCHECKED` when `inset_px is None`, else `PASS`

- [ ] **Step 1: Write the failing tests**

```python
import safe_zone as sz

AREA = (0, 0, 1000, 800)
BOX = sz.NameBox('FRONT', 'Custom Name', (200, 100, 600, 200))

def test_overflow_inset_and_larger_clearance():
    assert sz.overflow((10, 10, 50, 30), AREA) <= 0
    assert sz.overflow((10, 10, 1004, 30), AREA) == 4
    assert sz.overflow((10, 10, 1004, 30), AREA, x=False) <= 0
    assert sz.inset_rect(AREA, 60) == (60, 60, 940, 740)
    assert sz.safe_inset_px(0.2, 300, None) == 60
    assert sz.safe_inset_px(0.2, 200, 148.49) == 148.49
    assert sz.safe_inset_px(None, 300, None) is None

def test_rotated_bounds():
    box = {'x': 100, 'y': 100, 'w': 200, 'h': 100}
    assert sz.rotated_bounds(box, 0, None) == (100, 100, 300, 200)
    assert [round(v) for v in sz.rotated_bounds(box, 90, None)] == [150, 50, 250, 250]

def test_lone_no():
    assert sz.lone_no([('Custom Name: Yes Or No?', 'No'), ('Custom Name', 'KANTORSKI')])
    assert not sz.lone_no([('Custom Name: Yes Or No?', 'No'), ('Custom Name Yes or No', 'Yes')])
    assert not sz.lone_no([('Choose Back Design', 'No')])
    assert sz.lone_no([('_Enter Name:', 'no')], fields=('Enter Name',))

def test_judge_box_safe_unchecked_pass():
    assert sz.judge([BOX], [(210, 110, 590, 190)], AREA, 60).verdict == 'PASS'
    assert sz.judge([BOX], [(210, 110, 603, 190)], AREA, 60).verdict == 'PASS'          # 3 px tolerated
    r = sz.judge([BOX], [(210, 110, 605, 190)], AREA, 60)
    assert (r.verdict, r.guard, r.reason) == ('HOLD', 'BOX', 'tên vượt khung 5 px (FRONT · Custom Name)')
    size_fit = sz.NameBox('FRONT', 'Custom Name', (200, 100, 600, 200), check_y=False)
    assert sz.judge([size_fit], [(210, 110, 590, 320)], AREA, 60).verdict == 'PASS'     # descender below a fit:size box
    edge = sz.NameBox('FRONT', 'Custom Name', (20, 100, 420, 200))
    r = sz.judge([edge], [(30, 110, 400, 190)], AREA, 60)
    assert (r.guard, r.reason) == ('SAFE', 'tên chạm safe zone: lấn 40 px vào mép an toàn 60 px (FRONT · Custom Name)')
    r = sz.judge([BOX], [(210, 110, 590, 190)], AREA, None)
    assert (r.verdict, r.reason) == ('UNCHECKED', 'không kiểm được safe zone (không có template)')
    assert sz.judge([BOX], [None], AREA, 60, box_overflow=9).guard == 'BOX'
```

- [ ] **Step 2: Run** `python -m pytest tools/auto-render-hourly/tests/test_safe_zone.py -q` — Expected: FAIL, `No module named 'safe_zone'`.
- [ ] **Step 3: Implement the functions above in `safe_zone.py`.** `details` of every result carries `boxes`, `inks`, `overflowPx`, `insetPx`. The SAFE `{n}` is the largest overflow among boxes and inks.
- [ ] **Step 4: Run the same command** — Expected: 4 passed.
- [ ] **Step 5: Report to the coordinator (no commit).**

### Task 2: `safe_zone.py` — worker renders (pixel difference)

**Files:**
- Modify: `tools/auto-render-hourly/safe_zone.py`
- Test: `tools/auto-render-hourly/tests/test_worker_guard.py`

**Interfaces:**
- Consumes: Task 1.
- Produces: `INK_DIFF_THRESHOLD = 64`
  - `diff_mask(render: Image.Image, base: Image.Image, threshold: int = INK_DIFF_THRESHOLD) -> numpy.ndarray` — bool H×W, true where any RGBA channel differs by ≥ `threshold`; a base of another size is first resized to the render with `Image.LANCZOS` (what the worker does for a single-canvas entry); computed in bands of at most 2048 rows so peak memory stays near the two decoded images
  - `mask_bbox(mask) -> Rect | None`
  - `outside_boxes(mask, rects: list[Rect], tol: float) -> float` — largest distance (px, Chebyshev) of an ink pixel from its nearest rect; 0 when all ink is inside
  - `check_worker_piece(render_path: Path, base_path: Path | None, fields: list[dict], file_name: str, no_name_expected: bool, area: Rect, inset_px: float | None, photoshop_rule: dict | None = None, tol: float = TOLERANCE_PX) -> GuardResult`, decided in this order:
    1. `no_name_expected`: `-noname.` not in `file_name` → HOLD `NO`; base readable and `diff_mask` has any ink → HOLD `NO`; else PASS.
    2. `-noname.` in `file_name` (a no-data order) or `fields == []` (a static piece) → PASS.
    3. `photoshop_rule` (`targets [{cx, cy}]`, `maxW`, `maxH`): boxes = one per target, centred, `maxW × maxH`; `judge(boxes, [None…], area, inset_px)`; `details['inkSource'] = 'renderer'`. No `targets` (a `nativeSpec` rule) → UNCHECKED `không kiểm được safe zone (quy tắc Photoshop không có khung)`.
    4. `base_path` is `None` or missing → UNCHECKED `không kiểm được safe zone (thiếu artwork gốc để so)`.
    5. Mask empty → HOLD `BOX`, `file dựng không thấy tên ({area name})`.
    6. Boxes = `rotated_bounds(f['box'], f.get('rotation') or 0, f.get('pivot'))` per field (`area` name = the piece, `field` = `f['field']`); `judge(boxes, [mask_bbox], area, inset_px, tol, box_overflow=outside_boxes(mask, rects, 0))`.
- `Image.MAX_IMAGE_PIXELS = None` is set in `safe_zone.py` (sheets reach 12,289 × 5,906 px).

- [ ] **Step 1: Write the failing tests.** Helper in the test file: `piece(tmp_path, ink=None, shade=0, base_size=None)` saves a 600×400 RGBA base (a diagonal colour gradient, not flat) as `base.png` and `render.png` = the base with a black rectangle at `ink` (when `shade` > 0 the rectangle only darkens the pixels by `shade` levels); returns both paths. `FIELD = {'field': 'Custom Name', 'box': {'x': 200, 'y': 100, 'w': 200, 'h': 60}}`, `AREA = (0, 0, 600, 400)`.

```python
def check(tmp_path, ink, name='6001_1_Print_auto.png', no=False, inset=30, **kw):
    render, base = piece(tmp_path, ink=ink, shade=kw.pop('shade', 0))
    return sz.check_worker_piece(render, kw.pop('base', base), kw.pop('fields', [FIELD]), name, no, AREA, inset, **kw)

def test_name_inside_its_box_passes(tmp_path):
    assert check(tmp_path, (210, 110, 390, 150)).verdict == 'PASS'

def test_name_past_the_box_is_held(tmp_path):
    assert check(tmp_path, (210, 110, 403, 150)).verdict == 'PASS'
    r = check(tmp_path, (210, 110, 405, 150))
    assert (r.verdict, r.guard, r.reason) == ('HOLD', 'BOX', 'tên vượt khung 5 px (Print · Custom Name)')

def test_box_in_the_safe_margin_is_held(tmp_path):
    edge = {'field': 'Custom Name', 'box': {'x': 10, 'y': 100, 'w': 200, 'h': 60}}
    assert check(tmp_path, (20, 110, 200, 150), fields=[edge]).guard == 'SAFE'

def test_lone_no(tmp_path):
    assert check(tmp_path, None, name='6001_1_Print_auto-noname.png', no=True).verdict == 'PASS'
    assert check(tmp_path, None, name='6001_1_Print_auto.png', no=True).reason == 'khách chọn No nhưng file in có tên'
    assert check(tmp_path, (210, 110, 390, 150), name='6001_1_Print_auto-noname.png', no=True).guard == 'NO'

def test_faint_shadow_is_not_ink_and_missing_name_is_held(tmp_path):
    r = check(tmp_path, (150, 90, 450, 190), shade=20)
    assert (r.guard, r.reason) == ('BOX', 'file dựng không thấy tên (Print)')

def test_missing_library_artwork_is_unchecked(tmp_path):          # Review Focus 5
    r = check(tmp_path, (210, 110, 390, 150), base=tmp_path / 'gone.png')
    assert (r.verdict, r.reason) == ('UNCHECKED', 'không kiểm được safe zone (thiếu artwork gốc để so)')

def test_photoshop_rule_uses_its_targets(tmp_path):
    rule = {'targets': [{'cx': 300, 'cy': 130}], 'maxW': 200, 'maxH': 60}
    r = check(tmp_path, (0, 0, 600, 400), photoshop_rule=rule)     # whole canvas differs: not measured
    assert r.verdict == 'PASS' and r.details['inkSource'] == 'renderer'
    assert check(tmp_path, None, photoshop_rule={'targets': [{'cx': 80, 'cy': 130}], 'maxW': 200, 'maxH': 60}).guard == 'SAFE'

def test_base_of_another_size_is_resized(tmp_path):
    render, _ = piece(tmp_path, ink=(210, 110, 390, 150))
    small = tmp_path / 'small.png'; Image.open(tmp_path / 'base.png').resize((300, 200)).save(small)
    assert sz.check_worker_piece(render, small, [FIELD], 'x_auto.png', False, AREA, 30).verdict in ('PASS', 'HOLD')
```

`check` passes the piece name `Print` as the area name: `check_worker_piece` takes it from `fields[0].get('area')` or, when absent, the part of `file_name` between the line position and `_auto` (`6001_1_Print_auto.png` → `Print`).

- [ ] **Step 2: Run** `python -m pytest tools/auto-render-hourly/tests/test_worker_guard.py -q` — Expected: FAIL, `AttributeError: … check_worker_piece`.
- [ ] **Step 3: Implement** `diff_mask`, `mask_bbox`, `outside_boxes`, `check_worker_piece`.
- [ ] **Step 4: Run** — Expected: 8 passed.
- [ ] **Step 5: Report (no commit).**

### Task 3: `safe_zone.py` — flat-text outputs (the renderer's own ink, the no-name render)

**Files:**
- Modify: `tools/auto-render-hourly/safe_zone.py`, `tools/auto-render-hourly/tests/conftest.py`
- Test: `tools/auto-render-hourly/tests/test_flat_guard.py`

**Interfaces:**
- Consumes: Tasks 1–2 (`judge`, `diff_mask`).
- Produces: `SOLID_ALPHA = 128`
  - `load_name_render(tools_dir: Path)` — imports `<tools_dir>\name_render.py` by path (`importlib`), with `sys.dont_write_bytecode = True` and `tools_dir` on `sys.path` for its sibling imports; cached per path
  - `flat_boxes_and_inks(nr, spec: dict, spec_dir: Path, values: dict[str, str]) -> list[tuple[NameBox, Rect | None]]` — one pair per `spec['texts']` entry that gets a value (value = `values.get(field, t.get('fallback', '')).strip()`, upper-cased when `t['upper']`, exactly as `name_render.render`)
  - `min_clearance(spec: dict, area: str) -> float | None` — the largest `minimumCutClearancePx` of any object in the spec whose `area` equals `area` (walk the whole JSON)
  - `no_name_render(python: str, tools_dir: Path, spec_path: Path, out_dir: Path, key: str) -> dict[str, Path]` — runs `python name_render.py <spec> <out_dir> <key> _=_` (env `PYTHONDONTWRITEBYTECODE=1`, `PYTHONIOENCODING=utf-8`), returns `{print area: file}` from its `saved <path>` lines (area = the text after `<key> - ` in the file stem); non-zero exit raises `RuntimeError` with the last 200 chars of stderr
  - `images_equal(a: Path, b: Path) -> bool` — same size and `diff_mask` (both converted to RGB) has no ink
  - `check_flat_line(key: str, spec_path: Path, values: dict[str, str], said_no: bool, files: list[dict], files_root: Path, safe_in: float | None, tools_dir: Path, python: str, tmp_dir: Path, tol: float = TOLERANCE_PX) -> GuardResult` — `files` are the group's `{printArea, path | driveFileId, widthPx, heightPx, kind?}` (`kind: "MOCKUP"` entries are ignored); order:
    1. `said_no` and `values` → HOLD `NO`.
    2. Spec has `"photoshop": true` → UNCHECKED `không kiểm được safe zone (spec Photoshop)`.
    3. No `values`: every print file has `driveFileId` → PASS. `said_no`: `no_name_render` into `tmp_dir`, and for each text area of the spec present in `files` with a `path`: `images_equal(files_root / path, re-render)` false → HOLD `NO`; an area whose sizes differ → ERROR. Otherwise PASS.
    4. With `values`: `flat_boxes_and_inks`; per print area `judge(boxes, inks, (0, 0, widthPx, heightPx) of the pushed file, safe_inset_px(safe_in, spec.get('dpi', 150), min_clearance(spec, area)), tol)`. Result of the line = first HOLD (NO, BOX, SAFE), else first UNCHECKED, else PASS.
    5. Any exception from the renderer → ERROR `không đo được khung tên: {type}: {message}`.

The measuring algorithm of `flat_boxes_and_inks` (it is not determined by the signature; it places an opaque marker where the real text lands, so the renderer's own alignment, rotation and arc decide the position, and the glow halo — a padding `glow_layer` adds around the text — is left out):

```python
full = nr.render_text(t, value, spec_dir)
core = nr.render_text({k: v for k, v in t.items() if k != 'glow'}, value, spec_dir) if t.get('glow') else full
solid = core.getchannel('A').point(lambda a: 255 if a >= SOLID_ALPHA else 0)
marker = Image.new('RGBA', full.size, (0, 0, 0, 0))
marker.paste(Image.merge('RGBA', (solid,) * 4), ((full.width - core.width) // 2, (full.height - core.height) // 2))
sheet = Image.new('RGBA', Image.open(spec_dir / area['base']).size, (0, 0, 0, 0))
nr.place(sheet, t, marker)
ink = sheet.getchannel('A').getbbox()          # None when nothing was drawn
```

`NameBox` for a text: `rect = t['box']`; `fit == 'size'` → only the running axis is checked (`check_y=False` for `rotate` 0 or 180, `check_x=False` for ±90); a text with `circle` → both axes off (its box only caps the length along the circle).

- [ ] **Step 1: Add the stand-in renderer to `conftest.py`.** Fixture `fake_tools(tmp_path) -> Path` writes `<tmp>/g5tools/name_render.py` with the three entry points of the real file:
  - `render_text(t, value, spec_dir)` → an opaque black RGBA block of `t['_ink']` = `[w, h]` px; when `t.get('glow')`, wrapped in a 30 px halo of alpha 40 on every side;
  - `place(sheet, t, layer)` → `sheet.alpha_composite(layer, (x0 + (box width − layer width) // 2 + t.get('_dx', 0), y0 + t.get('_dy', 0)))`;
  - CLI `name_render.py <spec> <out> <LINE> Field=value …` → for each area saves `<out>/<LINE>/<LINE> - <printArea>.png`: the area's `base` (`baseNoName` when no text of the area has a value) with the placed layers; prints `saved <path>`.
  Fixture `flat_spec(tmp_path, texts, **spec_keys) -> Path` writes a spec folder with `base_FRONT.png` (1000×800, a gradient), `spec.json` (`design`, `dpi: 200`, one area `FRONT`, the given `texts`) and returns the spec path. Helper `render(spec, key, **values)` runs the stand-in CLI into `<tmp>/_out` and returns the group's `files`.

- [ ] **Step 2: Write the failing tests**

```python
TEXT = {'area': 'FRONT', 'field': 'Custom Name', 'box': [300, 300, 700, 380], '_ink': [200, 60]}

def run(tmp_path, fake_tools, text, values, said_no=False, safe_in=0.2, files=None, **spec_keys):
    spec = flat_spec(tmp_path, [text], **spec_keys)
    files = files if files is not None else render(spec, 'LIT1_1', **values)
    return sz.check_flat_line('LIT1_1', spec, values, said_no, files, tmp_path / '_out', safe_in, fake_tools, sys.executable, tmp_path / 'tmp')

def test_name_in_box_passes(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}).verdict == 'PASS'

def test_wide_name_is_held_with_the_overflow(tmp_path, fake_tools):
    r = run(tmp_path, fake_tools, {**TEXT, '_ink': [420, 60]}, {'Custom Name': 'Anna'})
    assert (r.guard, r.reason) == ('BOX', 'tên vượt khung 10 px (FRONT · Custom Name)')

def test_glow_halo_is_not_ink(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, {**TEXT, 'glow': [{'px': 10}], '_ink': [398, 60]}, {'Custom Name': 'Anna'}).verdict == 'PASS'

def test_fit_size_box_bounds_only_the_running_axis(tmp_path, fake_tools):
    tall = {**TEXT, 'fit': 'size', '_ink': [200, 140]}                       # 60 px below the box
    assert run(tmp_path, fake_tools, tall, {'Custom Name': 'Anna'}).verdict == 'PASS'
    assert run(tmp_path, fake_tools, {**tall, 'fit': 'box'}, {'Custom Name': 'Anna'}).guard == 'BOX'

def test_safe_zone_uses_the_larger_of_safe_in_and_cut_clearance(tmp_path, fake_tools):
    low = {**TEXT, 'box': [300, 700, 700, 770]}                              # 30 px from the bottom edge
    assert run(tmp_path, fake_tools, low, {'Custom Name': 'Anna'}, safe_in=0.1).verdict == 'PASS'    # inset 20 px
    assert run(tmp_path, fake_tools, low, {'Custom Name': 'Anna'}, safe_in=0.2).guard == 'SAFE'      # inset 40 px
    r = run(tmp_path, fake_tools, low, {'Custom Name': 'Anna'}, safe_in=0.1,
            sleeveRevision={'files': [{'area': 'FRONT', 'minimumCutClearancePx': 148.49}]})
    assert r.guard == 'SAFE' and r.details['insetPx'] == 148.49
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}, safe_in=None).verdict == 'UNCHECKED'

def test_lone_no(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}, said_no=True).reason == 'khách chọn No nhưng file in có tên'
    assert run(tmp_path, fake_tools, TEXT, {}, said_no=True).verdict == 'PASS'              # file equals the no-name render
    spec = flat_spec(tmp_path, [TEXT]); named = render(spec, 'LIT1_1', **{'Custom Name': 'Anna'})
    assert run(tmp_path, fake_tools, TEXT, {}, said_no=True, files=named).guard == 'NO'     # stale named file on disk
    links = [{'printArea': 'FRONT', 'driveFileId': 'abc'}]
    assert run(tmp_path, fake_tools, TEXT, {}, said_no=True, files=links).verdict == 'PASS'

def test_photoshop_spec_and_renderer_crash(tmp_path, fake_tools):
    assert run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'}, photoshop=True).verdict == 'UNCHECKED'
    r = run(tmp_path, fake_tools, {**TEXT, '_ink': 'oops'}, {'Custom Name': 'Anna'})
    assert r.verdict == 'ERROR' and r.reason.startswith('không đo được khung tên: ')

def test_nothing_is_written_next_to_the_renderer(tmp_path, fake_tools):
    run(tmp_path, fake_tools, TEXT, {'Custom Name': 'Anna'})
    assert sorted(p.name for p in fake_tools.iterdir()) == ['name_render.py']
```

- [ ] **Step 3: Run** `python -m pytest tools/auto-render-hourly/tests/test_flat_guard.py -q` — Expected: FAIL, `AttributeError: … check_flat_line`.
- [ ] **Step 4: Implement** the functions of this task.
- [ ] **Step 5: Run** — Expected: 8 passed. Then the whole folder: `python -m pytest tools/auto-render-hourly/tests -q` — 20 passed.
- [ ] **Step 6: Report (no commit).**

### Task 4: `auto_render.py` — config, mutex, disk, log, summary, retention, exit codes

**Files:**
- Create: `tools/auto-render-hourly/auto_render.py`
- Test: `tools/auto-render-hourly/tests/test_foundation.py`

**Interfaces:**
- Produces:
  - `EXIT_OK, EXIT_STAGE, EXIT_CONFIG, EXIT_DISK = 0, 1, 2, 3`; `MUTEX_NAME = r'Local\EcomManagerAutoRenderHourly'`; `DISK_FLOOR_GB = 30`; `RETAIN_DAYS = 30`
  - `home() -> Path` — env `AUTO_RENDER_HOME`, else `%USERPROFILE%\.auto-render`
  - `@dataclass Config`: `tool_worktree, main_checkout, artwork_builder: Path; local_url: str = 'http://localhost:3013'; ecom_url: str = ''; design_agent_token: str = ''; since_days: int = 14; box_tolerance_px: float = 3; node: list[str] = ['node']; python: str = sys.executable`
  - `load_config(path: Path) -> Config` — `KEY=VALUE` lines, `#` comments, optional quotes, `utf-8-sig`. Keys: `TOOL_WORKTREE`, `MAIN_CHECKOUT`, `ARTWORK_BUILDER` (required), `LOCAL_URL`, `ECOM_URL`, `DESIGN_AGENT_TOKEN`, `SINCE_DAYS`, `NAME_BOX_TOLERANCE_PX`. Raises `ConfigError(message)`: file missing → `thiếu file cấu hình <path>`; key missing → `thiếu <KEY> trong <path>`; a required file missing → `không thấy <path>`. Required files: `<TOOL_WORKTREE>\scripts\process-new-orders.mjs`, `…\push-local-renders.mjs`, `…\push-shared-prints.mjs`, `<TOOL_WORKTREE>\node_modules\next\dist\bin\next`, `<ARTWORK_BUILDER>\g5\tools\name_render.py`, `<MAIN_CHECKOUT>\dev.db`. `ECOM_URL` must be `https://…` (or `http://localhost…` / `http://127.0.0.1…`), else `ConfigError`
  - `acquire_mutex(name: str = MUTEX_NAME) -> int | None` — `kernel32.CreateMutexW`; `None` (and the duplicate handle closed) when `GetLastError() == 183`; `release_mutex(handle: int) -> None`. The mutex dies with the process, so a killed run never leaves it behind
  - `disk_free_gb(path: str = 'D:\\', usage=shutil.disk_usage) -> float`
  - `class RunLog(home: Path, now: datetime, secrets: list[str] = ())`: `.path` = `<home>\logs\<YYYY-MM-DD>.log`; `.line(text)` appends `[HH:MM:SS] text` (UTF-8) and prints it; `.block(stage, text)` appends a child process's output, each line prefixed `  <stage>| `; every string passed through `mask(text, secrets)` first
  - `new_summary(now, dry_run, since) -> dict` — keys `startedAt, finishedAt, dryRun, exitCode, since, snapshot, rendered, pushed, held, notAuto, unchecked, skipped, errors` (lists empty, `snapshot` null); `held` items `{taskKey, source, guard, reason, reported, jobId}`; `unchecked`/`skipped` items `{taskKey, reason}`; `errors` items `{stage, taskKey?, message}`
  - `write_summary(home: Path, summary: dict, now: datetime) -> Path` — `<home>\logs\run-<YYYYMMDD-HHMMSS>.json`, UTF-8, `ensure_ascii=False`
  - `prune(home: Path, now: datetime, days: int = RETAIN_DAYS) -> int` — deletes `logs\*.log` and `logs\run-*.json` older than `days` by mtime
  - `main(argv: list[str] | None = None) -> int` — arguments `--dry-run`, `--keep-snapshot`, `--config <path>` (default `<home>\config.env`). This task wires: config → mutex → disk → (later stages, added by Tasks 5–7, behind one function `run_stages(cfg, log, summary, args) -> int`) → summary → prune. An uncaught exception is logged with its traceback, added to `errors` (`stage: 'crash'`) and returns 1.

- [ ] **Step 1: Write the failing tests** (fixture `cfg_file(tmp_path, **overrides)` in `conftest.py` creates fake `TOOL_WORKTREE`, `MAIN_CHECKOUT`, `ARTWORK_BUILDER` trees holding the required files as empty files and writes `config.env`; `AUTO_RENDER_HOME` is set to `tmp_path / 'home'` by an autouse fixture)

```python
def test_config_reads_keys_and_defaults(cfg_file):
    cfg = ar.load_config(cfg_file())
    assert (cfg.since_days, cfg.local_url, cfg.box_tolerance_px, cfg.ecom_url) == (14, 'http://localhost:3013', 3, '')

def test_config_errors_are_loud(tmp_path, cfg_file):
    with pytest.raises(ar.ConfigError, match='thiếu file cấu hình'): ar.load_config(tmp_path / 'none.env')
    with pytest.raises(ar.ConfigError, match='thiếu ARTWORK_BUILDER'): ar.load_config(cfg_file(ARTWORK_BUILDER=None))
    path = cfg_file(); (Path(ar.load_config(path).tool_worktree) / 'scripts' / 'push-shared-prints.mjs').unlink()
    with pytest.raises(ar.ConfigError, match=r'không thấy .*push-shared-prints\.mjs'): ar.load_config(path)
    with pytest.raises(ar.ConfigError): ar.load_config(cfg_file(ECOM_URL='http://example.com'))

def test_mutex_is_exclusive_and_reusable():
    first = ar.acquire_mutex('Local\\AutoRenderTest'); assert first
    assert ar.acquire_mutex('Local\\AutoRenderTest') is None
    ar.release_mutex(first); again = ar.acquire_mutex('Local\\AutoRenderTest'); assert again; ar.release_mutex(again)

def test_main_exit_codes(cfg_file, monkeypatch, tmp_path):
    assert ar.main(['--config', str(tmp_path / 'none.env')]) == ar.EXIT_CONFIG
    monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 12.4)
    assert ar.main(['--config', str(cfg_file())]) == ar.EXIT_DISK
    held = ar.acquire_mutex(); monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 200.0)
    try: assert ar.main(['--config', str(cfg_file())]) == ar.EXIT_OK
    finally: ar.release_mutex(held)
    log = next((ar.home() / 'logs').glob('*.log')).read_text(encoding='utf-8')
    assert 'ổ D còn 12 GB, dưới 30 GB — dừng' in log and 'lần chạy trước chưa xong — bỏ qua lần này' in log

def test_summary_is_written_and_crash_is_recorded(cfg_file, monkeypatch):
    monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 200.0)
    monkeypatch.setattr(ar, 'run_stages', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    assert ar.main(['--config', str(cfg_file())]) == ar.EXIT_STAGE
    summary = json.loads(next((ar.home() / 'logs').glob('run-*.json')).read_text(encoding='utf-8'))
    assert summary['exitCode'] == 1 and summary['errors'] == [{'stage': 'crash', 'message': 'RuntimeError: boom'}]

def test_log_masks_the_token_and_prune_keeps_30_days(tmp_path):
    log = ar.RunLog(tmp_path, datetime(2026, 11, 12, 9, 0), secrets=['dag_secret-token-123'])
    log.line('gọi /hold với dag_secret-token-123'); assert 'dag_secret' not in log.path.read_text(encoding='utf-8')
    old = tmp_path / 'logs' / '2026-10-01.log'; old.write_text('x'); os.utime(old, (0, 0))
    assert ar.prune(tmp_path, datetime(2026, 11, 12)) == 1 and log.path.exists()
```

- [ ] **Step 2: Run** `python -m pytest tools/auto-render-hourly/tests/test_foundation.py -q` — Expected: FAIL, `No module named 'auto_render'`.
- [ ] **Step 3: Implement** the items above; `run_stages` returns `EXIT_OK` for now. The mutex-held path writes the log line and returns `EXIT_OK` without a summary file; the disk path writes a summary with `errors: [{stage: 'disk', …}]`.
- [ ] **Step 4: Run** — Expected: 6 passed.
- [ ] **Step 5: Report (no commit).**

### Task 5: `auto_render.py` — the local tool and `process-new-orders`

**Files:**
- Modify: `tools/auto-render-hourly/auto_render.py`, `tools/auto-render-hourly/tests/conftest.py`
- Create: `tools/auto-render-hourly/tests/fake_node.py`
- Test: `tools/auto-render-hourly/tests/test_tool_and_process.py`

**Interfaces:**
- Consumes: Task 4 (`Config`, `RunLog`).
- Produces:
  - `class StageError(Exception)` with `.stage`, `.message`, `.task_key = None`
  - `tool_reachable(url: str, timeout: float = 5) -> bool` — any HTTP answer from `GET <url>/api/auth/login` (405 included) is "up"; a refused or timed-out connection is "down"
  - `start_tool(cfg: Config, log: RunLog) -> None` — `node node_modules/next/dist/bin/next dev --port <port of LOCAL_URL>` with cwd `TOOL_WORKTREE`, detached (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`), output to `<home>\logs\tool-<YYYY-MM-DD>.log`; polls `tool_reachable` every 3 s up to `TOOL_WAIT_S = 120`; still down → `StageError('tool', 'tool local không lên sau 120 giây')`. The tool is left running after the run (other sessions use it)
  - `ensure_tool(cfg, log, local_db: Path) -> None` — reachable or started; then log in with `POST /api/auth/login` `{email, password}` from the two lines of `<MAIN_CHECKOUT>\.superpowers\local\local-login.txt` (the file `process-new-orders` itself uses; values never logged); then `GET /api/design-studio/tasks/<key>` for `known_task(local_db)`. Login or task not 2xx → `StageError('tool', f'tool local lỗi {status}')`. No task in `dev.db` yet → log `chưa có task local để thử`, continue
  - `known_task(local_db: Path) -> str | None` — `SELECT taskKey FROM DesignTask ORDER BY createdAt DESC LIMIT 1` (opened `mode=ro`)
  - `@dataclass ProcessResult`: `snapshot: Path; out_dir: Path; shared_spec: Path | None; flat: dict | None; flat_spec: Path | None`
  - `run_process_new_orders(cfg, since: str, out_dir: Path, log: RunLog, timeout_s: float = 1800) -> ProcessResult` — runs `node scripts/process-new-orders.mjs --since <since> --url <LOCAL_URL> --out <out_dir>` in `TOOL_WORKTREE` (never `--push`), env `PYTHONIOENCODING=utf-8`; output decoded UTF-8 into `log.block('process', …)`. Non-zero exit → `StageError('process', 'process-new-orders thoát mã <n>')`; timeout → the process tree is killed (`taskkill /T /F`), `StageError('process', 'process-new-orders quá 30 phút')`. `snapshot` = the path on the stdout line `snapshot <path>`; no such line or no such file → `StageError('process', 'không xác định được snapshot của lần chạy')`. `shared_spec` = `<out_dir>\spec-shared.json` when it has groups; `flat` = `<out_dir>\flat-text.json` parsed (`done`, `skipped`, `spec`); `flat_spec` = `Path(flat['spec'])` when that file has groups
  - `since_date(now: datetime, days: int) -> str` — `YYYY-MM-DD` of today − `days`
  - `drop_own_snapshot(cfg, snapshot: Path, log) -> bool` — deletes it only when its name matches `^prod-snap-\d{8}-\d{4,6}\.db$` and its parent is `<MAIN_CHECKOUT>\db-backups`

`tests/fake_node.py` stands in for `node` (`Config.node = [sys.executable, 'fake_node.py']`). It appends `{script, args, cwd}` to `<FAKE_NODE_DIR>\calls.jsonl` and reads `<FAKE_NODE_DIR>\plan.json`:

| First argument ends with | Behaviour from `plan.json` |
|---|---|
| `next` | writes its pid to `<FAKE_NODE_DIR>\tool.pid`, starts `http.server` on the `--port` given and serves forever (the "tool"); the `fake_node` fixture kills that pid at teardown |
| `process-new-orders.mjs` | `process.exit` code; `process.sleep` seconds; writes an empty file at `process.snapshot` and prints `snapshot <that path>` unless `process.noSnapshot`; writes `process.shared` → `<--out>\spec-shared.json` and `process.flat` → `<--out>\flat-text.json` |
| `push-local-renders.mjs`, `push-shared-prints.mjs` | Task 7 |

Fixture `local_tool(tasks_status=200, login_status=200)` starts a `ThreadingHTTPServer` on `127.0.0.1:0` answering `POST /api/auth/login` (sets a cookie) and `GET /api/design-studio/tasks/<key>`; records requests.

- [ ] **Step 1: Write the failing tests**

```python
def test_known_task_non_2xx_stops_the_run(cfg, local_tool, local_db):
    tool = local_tool(tasks_status=500); cfg.local_url = tool.url
    with pytest.raises(ar.StageError) as e: ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1']))
    assert (e.value.stage, e.value.message) == ('tool', 'tool local lỗi 500')

def test_login_failure_stops_the_run_without_logging_the_password(cfg, local_tool, local_db):
    tool = local_tool(login_status=401); cfg.local_url = tool.url
    with pytest.raises(ar.StageError, match='tool local lỗi 401'): ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1']))
    assert 'local-pass' not in log.path.read_text(encoding='utf-8')          # the fixture's login file holds 'local-pass'

def test_healthy_tool_passes_and_empty_db_is_not_an_error(cfg, local_tool, local_db):
    tool = local_tool(); cfg.local_url = tool.url
    ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1'])); assert tool.paths[-1] == '/api/design-studio/tasks/LIT1_1'
    ar.ensure_tool(cfg, log, local_db(tasks=[]))

def test_down_tool_is_started_in_the_worktree(cfg, free_port, local_db, fake_node):
    cfg.local_url = f'http://127.0.0.1:{free_port}'
    with pytest.raises(ar.StageError, match='tool local lỗi'):                 # the stand-in serves 404 for the API
        ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1']))
    call = fake_node.calls()[0]
    assert call['args'][-3:] == ['dev', '--port', str(free_port)] and Path(call['cwd']) == cfg.tool_worktree

def test_process_run_never_pushes_and_finds_its_snapshot(cfg, fake_node, tmp_path):
    snap = cfg.main_checkout / 'db-backups' / 'prod-snap-20261112-0900.db'
    fake_node.plan(process={'snapshot': str(snap), 'shared': {'groups': []}})
    pr = ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'out', log)
    args = fake_node.calls()[0]['args']
    assert '--push' not in args and args[args.index('--since') + 1] == '2026-10-29'
    assert pr.snapshot == snap and pr.shared_spec is None and pr.flat is None

def test_process_failures_are_stage_errors(cfg, fake_node, tmp_path):
    fake_node.plan(process={'exit': 1})
    with pytest.raises(ar.StageError, match='process-new-orders thoát mã 1'): ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'o1', log)
    fake_node.plan(process={'noSnapshot': True})
    with pytest.raises(ar.StageError, match='không xác định được snapshot'): ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'o2', log)
    fake_node.plan(process={'sleep': 30})
    with pytest.raises(ar.StageError, match='quá'): ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'o3', log, timeout_s=1)

def test_only_the_runs_own_snapshot_is_deleted(cfg):
    backups = cfg.main_checkout / 'db-backups'
    own = backups / 'prod-snap-20261112-0900.db'; other = backups / 'prod-snap-20261111c-after-mango-fix.db'
    own.write_bytes(b'x'); other.write_bytes(b'x')
    assert ar.drop_own_snapshot(cfg, own, log) and not own.exists()
    assert not ar.drop_own_snapshot(cfg, other, log) and other.exists()

def test_since_date():
    assert ar.since_date(datetime(2026, 11, 12, 9, 0), 14) == '2026-10-29'
```

- [ ] **Step 2: Run** `python -m pytest tools/auto-render-hourly/tests/test_tool_and_process.py -q` — Expected: FAIL, `AttributeError: … ensure_tool`.
- [ ] **Step 3: Implement** the functions and the two fakes.
- [ ] **Step 4: Run** — Expected: 8 passed.
- [ ] **Step 5: Report (no commit).**

### Task 6: `auto_render.py` — the plan: readiness, the three sources, the guards, the filtered specs

**Files:**
- Modify: `tools/auto-render-hourly/auto_render.py`, `tools/auto-render-hourly/tests/conftest.py`
- Test: `tools/auto-render-hourly/tests/test_plan.py`

**Interfaces:**
- Consumes: `safe_zone` (Tasks 1–3), `Config`, `ProcessResult`, `StageError`.
- Produces:
  - `@dataclass Line`: `key: str; source: str` (`'local-render' | 'flat-text' | 'reuse'`); `status: str | None; readiness: str | None; result: GuardResult`
  - `@dataclass Plan`: `lines: list[Line]; push_local: list[str]; shared_spec: Path | None; flat_spec: Path | None; pushable: set[str]; skipped: list[dict]; errors: list[dict]`
  - `read_prod(snapshot: Path) -> dict[str, dict]` — per `taskKey`: `status`, `readiness`, `prints` (live PRINT rows), `sku`, `resolvedSupplierId`, `resolvedSupplierSku`, `variantTitle`, `shopifyProductId`, `storeId`, `pairs` (customer inputs: `customallFieldsJson` pairs + `customAttributesJson` pairs with leading `_` stripped). Opened `mode=ro`
  - `local_render_files(local_db: Path, since: str) -> dict[str, list[dict]]` — the script's own selection: `DesignArtwork` rows with `source='AUTO'`, `kind='PRINT'`, `removedAt IS NULL`, `storagePath IS NOT NULL`, `createdAt >= since`, whose local task is `REVIEW`; newest version per (task, print area); each with `printArea, fileName, storagePath, widthPx, heightPx, entryId, pieceId`
  - `worker_inputs(local_db, row: dict, storage_root: Path, rules: dict) -> dict` — for one file: `fields` (the piece's `ArtworkPiece.fields`, or `ArtworkEntry.fields` when `pieceId` is null), `base_path` (`<storage_root>\<LibraryFile.storagePath>`, else `%USERPROFILE%\.artwork-worker\artwork\<sha256>`, else `None`), `safe_in`, `dpi` (the template piece's `dpi`, else the template's), `area` (single-canvas template with an `areas` entry named like the print area → that rect; otherwise the whole file), `photoshop_rule` (`rules.get(entryId)`)
  - `load_photoshop_rules(artwork_builder: Path) -> dict[str, dict]` — `design-rules\*.json` → `entries` with `renderer == 'photoshop'`; a file that is not JSON raises `StageError('guard', 'file quy tắc <name> lỗi')`
  - `design_of(sku: str) -> str | None` and `resolve_flat_spec(flat_root: Path, key: str, prod: dict) -> Path` — port of `flat_text_batch.py`'s `design_of` and `cands` filter: specs with `design == design_of(sku)` that satisfy every key they carry — `shopifyProductId` (equal), `storeId` (equal), `supplierSku` (the line's `resolvedSupplierSku` starts with it, case-insensitive), `skuContains`, `skuIs` (whole SKU, stripped), `skuNot`, `skuEnds`, `variantContains` (all case-insensitive), `minOrder` (first number in the key ≥ it, or the key is in `alsoLines`), `match` (every `{key: value}` equals one of the line's pairs; keys compared lower-cased, stripped of trailing `:`/`?`). Exactly one → its path; otherwise raises `SpecUnresolved(count)`
  - `template_safe_in(snapshot: Path, supplier_id, supplier_sku) -> float | None` — exact `supplierSku`, else the longest `supplierSku` the line's SKU starts with (case-insensitive, same supplier)
  - `build_plan(cfg: Config, pr: ProcessResult, since: str, tmp_dir: Path, log: RunLog) -> Plan`
  - `filter_spec(spec_path: Path, keep: set[str]) -> Path | None` — writes `<stem>.auto.json` **next to the original** (paths in a spec are relative to its folder): each group's `lines` cut to `keep`, empty groups dropped; `None` when nothing is left

`build_plan` rules:
1. A line is a candidate when prod has it `NEW` with no live print. Sources: (a) `local_render_files`; (b) flat-text: the groups of `pr.flat_spec`, values from `pr.flat['done']` (`[key, design, values]`); (c) reuse: groups of `pr.shared_spec` whose files all have `driveFileId`. A shared group with any `path` file (cm-builder) → `skipped` `cm-builder: không thuộc auto render hàng giờ`.
2. Guards: (a) every file through `check_worker_piece` (`no_name_expected = lone_no(pairs, field names)`, `inset_px = safe_inset_px(safe_in, dpi, None)`), line result = first HOLD, else first UNCHECKED, else PASS; (b) `check_flat_line` with `said_no = lone_no(pairs)`, `safe_in = template_safe_in(…)`, `files_root` = the flat spec's folder, `tools_dir = <ARTWORK_BUILDER>\g5\tools`, tolerance `cfg.box_tolerance_px`; `SpecUnresolved` → `GuardResult('ERROR', None, 'không xác định được spec flat-text (<n> spec khớp)', {})`; resolved spec whose text-area base size differs from the pushed file's size → ERROR `spec flat-text không khớp khổ file`; (c) reuse lines carry no name → PASS.
3. `pushable` = keys with prod readiness `AUTO` and verdict `PASS` or `UNCHECKED`. `push_local` = pushable local-render keys, sorted. `shared_spec` / `flat_spec` = `filter_spec(…, pushable)`.
4. ERROR lines go to `Plan.errors` (`stage: 'guard'`, `taskKey`, `message` = the reason).

- [ ] **Step 1: Add fixtures to `conftest.py`.** `make_dbs(tmp_path, lines)` builds `dev.db` and a snapshot with only the columns the queries read (`DesignTask`, `"Order"`, `OrderLine`, `DesignArtwork`, `ArtworkEntry`, `ArtworkPiece`, `LibraryFile`, `PrintTemplate`); each `lines` item gives `key, readiness, status='NEW', sku, supplierSku, pairs, prodPrints=0` and, for a local render, `ink` (drawn with Task 2's `piece` helper into the fake storage) and `fileName`. `flat_run(specs, done)` renders flat lines with the stand-in renderer and returns a `ProcessResult`.

- [ ] **Step 2: Write the failing tests**

```python
def keys(plan, verdict): return sorted(l.key for l in plan.lines if l.result.verdict == verdict)

def test_only_passing_auto_lines_are_pushable(cfg, make_dbs, tmp_path):
    pr = make_dbs(tmp_path, [
        dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
        dict(key='LIT2_1', readiness='LOW', ink=(210, 110, 390, 150)),          # renders fine, prod says LOW
        dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150)),         # past its box
        dict(key='LIT4_1', readiness='AUTO', ink=(210, 110, 390, 150), status='REVIEW'),   # already moved on prod
    ])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert plan.push_local == ['LIT1_1'] and keys(plan, 'HOLD') == ['LIT3_1']
    assert 'LIT4_1' not in {l.key for l in plan.lines}
    assert next(l for l in plan.lines if l.key == 'LIT2_1').readiness == 'LOW' and 'LIT2_1' not in plan.pushable

def test_lone_no_on_a_worker_line(cfg, make_dbs, tmp_path):
    no = [('Custom Name: Yes Or No?', 'No'), ('Custom Name', 'KANTORSKI')]
    pr = make_dbs(tmp_path, [dict(key='LIT5_1', readiness='AUTO', pairs=no, ink=(210, 110, 390, 150), fileName='5_1_Print_auto.png'),
                             dict(key='LIT6_1', readiness='AUTO', pairs=no, ink=None, fileName='6_1_Print_auto-noname.png')])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert keys(plan, 'HOLD') == ['LIT5_1'] and plan.push_local == ['LIT6_1']

def test_flat_spec_is_filtered_next_to_the_original(cfg, flat_run, tmp_path):
    pr = flat_run(specs={'TN1-M': dict(design='TN1', supplierSku='M-15')},
                  done=[dict(key='LIT7_1', readiness='AUTO', sku='TN1-M-15X14INCH', supplierSku='M-15', values={'Custom Name': 'Anna'}),
                        dict(key='LIT8_1', readiness='MANUAL', sku='TN1-M-15X14INCH', supplierSku='M-15', values={'Custom Name': 'Bo'})])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert plan.flat_spec.parent == pr.flat_spec.parent and plan.flat_spec.name.endswith('.auto.json')
    assert [g['lines'] for g in json.loads(plan.flat_spec.read_text(encoding='utf-8'))['groups']] == [['LIT7_1']]

def test_unresolved_spec_is_an_error_not_a_push(cfg, flat_run, tmp_path):                  # Review Focus 4
    two = {'TN1-RED': dict(design='TN1'), 'TN1-PINK': dict(design='TN1')}
    pr = flat_run(specs=two, done=[dict(key='LIT9_1', readiness='AUTO', sku='TN1-M', supplierSku='M-15', values={'Custom Name': 'Anna'})])
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert plan.flat_spec is None and 'LIT9_1' not in plan.pushable
    assert plan.errors == [{'stage': 'guard', 'taskKey': 'LIT9_1', 'message': 'không xác định được spec flat-text (2 spec khớp)'}]

def test_spec_filter_port(tmp_path, write_spec):
    write_spec('A', design='TN1', supplierSku='WZIP-XL', skuContains='Zip', match={'Choose Color': 'Option 5'})
    write_spec('B', design='TN1', supplierSku='WZIP-XL', skuContains='Zip', match={'Choose Color': 'Option 3'})
    write_spec('C', design='TN1', minOrder=6000, skuNot='Zip')
    prod = dict(sku='TN1-Fleece Zip Hoodie', resolvedSupplierSku='wzip-xl', variantTitle='XL', shopifyProductId='p', storeId='s',
                pairs=[('Choose Color:', 'option 5')])
    assert ar.resolve_flat_spec(tmp_path, 'LIT6100_1', prod).parent.name == 'A'
    assert ar.design_of('upload-BLANK=TN0506261601') == 'TN0506261601' and ar.design_of('TN0506261601-M-15X14INCH') == 'TN0506261601'

def test_reuse_goes_and_cm_builder_does_not(cfg, make_dbs, tmp_path):
    pr = make_dbs(tmp_path, [dict(key='LIT10_1', readiness='AUTO'), dict(key='LIT11_1', readiness='AUTO')],
                  shared={'groups': [{'source': 'LIT1', 'lines': ['LIT10_1'], 'files': [{'printArea': 'Print', 'driveFileId': 'd1'}]},
                                     {'source': 'LIT11_1', 'lines': ['LIT11_1'], 'files': [{'printArea': 'Print', 'path': 'cm/LIT11_1.png'}]}]})
    plan = ar.build_plan(cfg, pr, '2026-10-29', tmp_path / 'tmp', log)
    assert [g['lines'] for g in json.loads(plan.shared_spec.read_text(encoding='utf-8'))['groups']] == [['LIT10_1']]
    assert plan.skipped == [{'taskKey': 'LIT11_1', 'reason': 'cm-builder: không thuộc auto render hàng giờ'}]
```

- [ ] **Step 3: Run** `python -m pytest tools/auto-render-hourly/tests/test_plan.py -q` — Expected: FAIL, `AttributeError: … build_plan`.
- [ ] **Step 4: Implement** the functions of this task. Storage root = env `DESIGN_STORAGE_DIR`, else `<MAIN_CHECKOUT>\storage` (the scripts' own rule). Every SQLite file is opened `file:<path>?mode=ro`.
- [ ] **Step 5: Run** — Expected: 6 passed.
- [ ] **Step 6: Report (no commit).**

### Task 7: `auto_render.py` — push under `.push-lock`, `/hold`, dry run, the whole run

**Files:**
- Modify: `tools/auto-render-hourly/auto_render.py`, `tools/auto-render-hourly/tests/fake_node.py`, `tools/auto-render-hourly/tests/conftest.py`
- Test: `tools/auto-render-hourly/tests/test_push.py`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `class LockBusy(Exception)`; `class PushLock(lock_dir: Path, home: Path, wait_s: float = 1800, poll_s: float = 10, sleep=time.sleep, clock=time.monotonic)` — context manager. Enter: `recover()` first; then `mkdir` in a loop until it succeeds or `wait_s` passes (`LockBusy`); then write the marker `<home>\push-lock.owner` (this pid). Exit: delete the marker **first**, then `rmdir`. `recover()`: marker exists, the lock folder exists and the marker's pid is not a live process → `rmdir` the lock, delete the marker, return `True`; a marker without a lock folder is just deleted. A lock without our marker is never removed
  - `push_local_line(cfg, snapshot: Path, since: str, key: str, started: datetime, log) -> str` — runs the three stages in order, each `node scripts/push-local-renders.mjs --snapshot <db> --since <since> --line <key> <--apply|--prove|--push>` in `TOOL_WORKTREE`; returns `'pushed'` or `'skipped: <reason>'`
  - `push_spec(cfg, spec: Path, snapshot: Path, ledger_dir: Path | None, keys: list[str], started: datetime, log) -> dict[str, str]` — three stages of `node scripts/push-shared-prints.mjs --spec <spec> --snapshot <db> [--out <ledger_dir>] <stage>`; per key `'pushed'` or `'skipped: <reason>'`
  - Both raise `StageError(stage, message, task_key)` when a stage exits non-zero (`<script> <stage> thoát mã <n>`), when its output has a line containing `DỪNG:` (the text after it is the message), or when the ledger has neither `applied` nor `skippedOnProd` for a key after `--push` (`đẩy xong nhưng ledger không ghi nhận dòng`). Ledgers: `<MAIN_CHECKOUT>\db-backups\push-local-renders\ledger.json`, `…\push-shared-prints\ledger.json` (reuse), `<home>\flat-ledger\ledger.json` (flat-text, passed as `--out` so a rerun finds its Drive uploads). `pushed` = `lines[key].applied` parses to a time ≥ `started`; `skipped` = `lines[key].skippedOnProd`
  - `class HoldState(home: Path)` — `<home>\holds.json` `{taskKey: {sig, reportedAt, jobId}}`; `.needs_report(key, guard, reason) -> bool` (`sig` = sha256 of `guard|reason`); `.record(key, guard, reason, job_id)`; `.forget(except_keys)` drops lines no longer held
  - `post_hold(cfg, key: str, reason: str) -> str | None` — `POST <ECOM_URL>/api/design-agent/runner/hold` `{"taskKey", "reason"}`, header `Authorization: Bearer <token>`, timeout (10, 60), no redirects; returns `jobId` (may be `None`: switch off, note only); not 2xx → `StageError('hold', f'/hold trả {status}', key)`; the token never appears in the message
  - `run_stages(cfg, log, summary, args) -> int` — the whole run (replaces Task 4's stub)

`run_stages` order: `since_date` → `ensure_tool` → `run_process_new_orders` (out dir `<MAIN_CHECKOUT>\db-backups\process-new-orders\auto-<YYYYMMDD-HHMMSS>`) → `build_plan` → fill `summary` (`rendered` = every candidate key; `notAuto` = candidates whose readiness is not AUTO; `held`, `unchecked`, `skipped`, `errors`) → unless `--dry-run`: push phase → hold phase → `drop_own_snapshot` (also in a dry run and after a failure, unless `--keep-snapshot`) → return 1 when `summary['errors']` is not empty, else 0. A `StageError` anywhere is logged, added to `errors` and ends the stages (the snapshot is still dropped).

Push phase: nothing pushable → skipped, no lock taken. Else `with PushLock(<ARTWORK_BUILDER>\.push-lock, home, wait_s=min(1800, time left − 300))`: `LockBusy` → error `{stage: 'lock', message: 'khoá .push-lock bận quá <m> phút — chưa đẩy, để lần sau'}`. Inside: local lines one at a time (`push_local_line`), then the reuse spec, then the flat spec. The first `StageError` stops the phase (the remaining lines wait for the next hour). Before each push: under 180 s to the run deadline (start + 50 min) → stop with error `{stage: 'push', message: 'hết giờ của lần chạy — phần còn lại để lần sau'}`. `skipped: …` outcomes go to `summary['skipped']`.

Hold phase: for each held line, `reported = False`. `ECOM_URL` and `DESIGN_AGENT_TOKEN` both set → when `HoldState.needs_report` → `post_hold`, record, `reported = True`, `jobId` stored; already reported with the same reason → `reported = True` from the state, no call. Config absent → log `giữ lại <key>: <reason> (chưa cấu hình /hold — chỉ ghi log)`. Dry run → no call, no state write, log line prefixed `[chạy thử]`.

`fake_node.py` additions: for the push scripts it reads `plan.json` `push: {<key>: 'applied' | 'skipped' | 'stop' | 'exit1' | 'noledger'}` (default `applied`); the keys come from `--line` or the spec's groups; on `--push` it writes the ledger at the script's default path under `FAKE_MAIN_CHECKOUT` or under `--out` (`applied`: now; `skipped`: `skippedOnProd: 'Task trên prod đang REVIEW'`), prints `  DỪNG: app không online trước chunk-x.json` for `stop`, exits 1 for `exit1`. Fixture `agent_server` (a `ThreadingHTTPServer`) answers `POST /api/design-agent/runner/hold`: 401 `{"error": "unauthorized"}` without the bearer, else `{"ok": true, "jobId": <configured>}`; records bodies.

- [ ] **Step 1: Write the failing tests**

```python
def test_end_to_end_pushes_passing_auto_lines_and_holds_the_rest(world):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                     dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150)),
                     dict(key='LIT2_1', readiness='LOW', ink=(210, 110, 390, 150))], hold=True)
    assert ar.main(['--config', str(w.config)]) == 0
    s = w.summary()
    assert (s['pushed'], s['notAuto'], s['rendered']) == (['LIT1_1'], ['LIT2_1'], ['LIT1_1', 'LIT2_1', 'LIT3_1'])
    assert s['held'] == [{'taskKey': 'LIT3_1', 'source': 'local-render', 'guard': 'BOX',
                          'reason': 'tên vượt khung 15 px (Print · Custom Name)', 'reported': True, 'jobId': 'job-1'}]
    assert w.agent.holds == [{'taskKey': 'LIT3_1', 'reason': 'tên vượt khung 15 px (Print · Custom Name)'}]
    stages = [c['args'][-1] for c in w.node.calls() if c['script'].endswith('push-local-renders.mjs')]
    assert stages == ['--apply', '--prove', '--push'] and not (w.artwork_builder / '.push-lock').exists()
    assert not w.snapshot.exists()                                             # own snapshot dropped

def test_dry_run_does_everything_but_push_and_hold(world):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                     dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True)
    assert ar.main(['--config', str(w.config), '--dry-run']) == 0
    s = w.summary()
    assert s['dryRun'] and s['pushed'] == [] and s['held'][0]['reported'] is False and w.agent.holds == []
    assert not any('push-' in c['script'] for c in w.node.calls()) and not (w.home / 'holds.json').exists()

def test_stop_or_missing_ledger_is_never_reported_pushed(world):                # Review Focus 2
    for outcome, text in [('stop', 'app không online'), ('noledger', 'ledger không ghi nhận'), ('exit1', 'thoát mã 1')]:
        w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150)),
                         dict(key='LIT4_1', readiness='AUTO', ink=(210, 110, 390, 150))], push={'LIT1_1': outcome})
        assert ar.main(['--config', str(w.config)]) == 1
        s = w.summary(); assert s['pushed'] == [] and text in s['errors'][0]['message'] and s['errors'][0]['taskKey'] == 'LIT1_1'
        assert not any('LIT4_1' in c['args'] for c in w.node.calls())           # the phase stopped

def test_skipped_on_prod_is_reported_as_skipped(world):
    w = world(lines=[dict(key='LIT1_1', readiness='AUTO', ink=(210, 110, 390, 150))], push={'LIT1_1': 'skipped'})
    assert ar.main(['--config', str(w.config)]) == 0
    assert w.summary()['skipped'] == [{'taskKey': 'LIT1_1', 'reason': 'Task trên prod đang REVIEW'}]

def test_lock_waits_then_gives_up_without_breaking_it(tmp_path):
    lock = tmp_path / '.push-lock'; lock.mkdir(); clock = FakeClock()
    with pytest.raises(ar.LockBusy):
        with ar.PushLock(lock, tmp_path, wait_s=1800, poll_s=10, sleep=clock.sleep, clock=clock.now): pass
    assert lock.exists() and clock.slept == 1800

def test_own_stale_lock_is_recovered_another_holders_is_not(tmp_path):          # Review Focus 1
    lock = tmp_path / '.push-lock'; lock.mkdir(); (tmp_path / 'push-lock.owner').write_text(str(DEAD_PID))
    with ar.PushLock(lock, tmp_path, wait_s=0): assert (tmp_path / 'push-lock.owner').read_text() == str(os.getpid())
    assert not lock.exists() and not (tmp_path / 'push-lock.owner').exists()
    lock.mkdir(); (tmp_path / 'push-lock.owner').write_text(str(os.getpid()))   # a live pid: not ours to break
    with pytest.raises(ar.LockBusy):
        with ar.PushLock(lock, tmp_path, wait_s=0): pass
    assert lock.exists()

def test_hold_is_reported_once_per_reason(world):                               # Review Focus 3
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True)
    ar.main(['--config', str(w.config)]); w.rerun(); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 1 and w.summary()['held'][0]['reported'] is True
    w.rerun(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 440, 150))]); ar.main(['--config', str(w.config)])
    assert len(w.agent.holds) == 2

def test_hold_without_config_is_log_only_and_a_refused_hold_fails_the_run(world):
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=False)
    assert ar.main(['--config', str(w.config)]) == 0 and 'chưa cấu hình /hold — chỉ ghi log' in w.log()
    w = world(lines=[dict(key='LIT3_1', readiness='AUTO', ink=(210, 110, 420, 150))], hold=True, token='wrong')
    assert ar.main(['--config', str(w.config)]) == 1
    assert w.summary()['errors'][0] == {'stage': 'hold', 'taskKey': 'LIT3_1', 'message': '/hold trả 401'} and 'wrong' not in w.log()

def test_flat_text_goes_through_its_own_stable_ledger(world):
    w = world(flat=[dict(key='LIT7_1', readiness='AUTO', values={'Custom Name': 'Anna'})])
    assert ar.main(['--config', str(w.config)]) == 0 and w.summary()['pushed'] == ['LIT7_1']
    call = next(c for c in w.node.calls() if c['script'].endswith('push-shared-prints.mjs'))
    assert call['args'][call['args'].index('--out') + 1] == str(w.home / 'flat-ledger') and call['args'][call['args'].index('--spec') + 1].endswith('.auto.json')
```

`world(...)` (in `conftest.py`) assembles Tasks 4–6 fixtures: config, fake node plan, local tool, databases, optional `agent_server`, a healthy disk; `DEAD_PID` is the pid of a child process that has exited; `FakeClock` advances on `sleep`.

- [ ] **Step 2: Run** `python -m pytest tools/auto-render-hourly/tests/test_push.py -q` — Expected: FAIL, `AttributeError: … PushLock`.
- [ ] **Step 3: Implement** the items of this task.
- [ ] **Step 4: Run** `python -m pytest tools/auto-render-hourly/tests -q` — Expected: 49 passed.
- [ ] **Step 5: Report (no commit).**

### Task 8: `run.ps1`, `install-task.ps1`, `README.md`

**Files:**
- Create: `tools/auto-render-hourly/run.ps1`, `tools/auto-render-hourly/install-task.ps1`, `tools/auto-render-hourly/README.md`

**Interfaces:**
- Consumes: `auto_render.py` (`main`, exit codes).

- [ ] **Step 1: Write `run.ps1`.** `param([string]$Python = 'python', [switch]$DryRun, [switch]$KeepSnapshot)`. Sets `$env:PYTHONUTF8 = '1'`, `$env:PYTHONIOENCODING = 'utf-8'`, `$env:PYTHONDONTWRITEBYTECODE = '1'`; runs `& $Python "$PSScriptRoot\auto_render.py"` with `--dry-run` / `--keep-snapshot` when the switches are set; `exit $LASTEXITCODE`. It takes no mutex and writes no log itself (`auto_render.py` does both, so they are covered by tests); when `$Python` cannot be started it appends one line to `%USERPROFILE%\.auto-render\logs\<yyyy-MM-dd>.log` (`không chạy được python: <path>`) and exits 2.

- [ ] **Step 2: Write `install-task.ps1`**, on the pattern of `tools/clone-runner/install-task.ps1` (same interpreter probe: a real `python.exe` ≥ 3.12 outside `\WindowsApps\`, else "Nothing registered", exit 1). `param([string]$Python = 'python', [string]$TaskName = 'EcomManager Auto Render Hourly', [switch]$PrintOnly)`:
  - action: `powershell.exe` `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "<here>\run.ps1" -Python "<resolved python.exe>"`, working directory `<here>`
  - trigger: `New-ScheduledTaskTrigger -Once -At <the next full hour> -RepetitionInterval (New-TimeSpan -Hours 1)` (no `-RepetitionDuration`: repeats indefinitely)
  - settings: `New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`
  - principal: the current user, `-LogonType Interactive -RunLevel Limited` (as "EcomManager Disk Janitor": `InteractiveToken`)
  - refuses (exit 1, "Nothing registered") when `%USERPROFILE%\.auto-render\config.env` does not exist
  - `-PrintOnly`: prints program, arguments, working directory, trigger, limit and policy and registers nothing.

- [ ] **Step 3: Verify the scripts without registering anything**

Run: `powershell -NoProfile -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('tools\auto-render-hourly\run.ps1',[ref]$null,[ref]$e); [void][System.Management.Automation.Language.Parser]::ParseFile('tools\auto-render-hourly\install-task.ps1',[ref]$null,[ref]$e); $e.Count"` — Expected: `0`.
Run: `powershell -NoProfile -ExecutionPolicy Bypass -File tools\auto-render-hourly\install-task.ps1 -PrintOnly` — Expected: either the printed plan ending with `Nothing registered (-PrintOnly).`, or the config refusal; then `Get-ScheduledTask -TaskName 'EcomManager Auto Render Hourly' -ErrorAction SilentlyContinue` prints nothing.
Run: `python tools\auto-render-hourly\auto_render.py --config tools\auto-render-hourly\tests\none.env; echo $LASTEXITCODE` — Expected: the line `thiếu file cấu hình …` and `2`.

- [ ] **Step 4: Write `README.md`** (Vietnamese for everything the owner reads) with these sections and facts:
  - **Nó làm gì** — the eight stages in one list; "không có AI trong lần chạy; không duyệt, không đụng xưởng, không email khách".
  - **Cài đặt (chủ shop)** — create `%USERPROFILE%\.auto-render\config.env` with the key table (`TOOL_WORKTREE`, `MAIN_CHECKOUT`, `ARTWORK_BUILDER` required; `LOCAL_URL` default `http://localhost:3013`; `ECOM_URL` + `DESIGN_AGENT_TOKEN` optional: without them a hold is only logged; `SINCE_DAYS` default 14; `NAME_BOX_TOLERANCE_PX` default 3); what the run needs from the PC and does not configure: `node` and `python` 3.12 on PATH, `<MAIN_CHECKOUT>\.superpowers\local\local-login.txt`, `%USERPROFILE%\.artwork-worker\local.env`, the SSH key the scripts use. First run by hand: `run.ps1 -DryRun`, read the summary; then `install-task.ps1` (only the owner, or the agent on his word).
  - **Kết quả một lần chạy** — log `logs\<ngày>.log`, summary `logs\run-<stamp>.json` with the meaning of each key, 30 days; the exit-code table (0/1/2/3).
  - **Dòng bị giữ** — the three guards in plain words, the reason texts, "giữ lại chứ không tự thu nhỏ tên"; with `/hold` configured and the switch on, the line becomes a job for the Design Agent, reported once per reason.
  - **Giới hạn đã biết** — builder's calls 3, 4, 5, 9 of this plan in plain words, with the measured numbers; non-AUTO lines are still rendered locally each hour (the script has no readiness filter) but never pushed; a person running `process-new-orders` by hand at the same minute shares `dev.db` and the tool with the run.
  - **Chưa kiểm chứng** — the scheduled task itself, a real push, a real `/hold`, a real one-hour run inside 55 minutes.
  - **Test** — `python -m pytest tools/auto-render-hourly/tests -q`.

- [ ] **Step 5: Run the whole suite once more** — `python -m pytest tools/auto-render-hourly/tests -q` — Expected: 49 passed. Confirm that this plan created files only under `tools/auto-render-hourly/` and that the tool worktree, `artwork-builder` and `%USERPROFILE%\.auto-render` were not touched by the tests (they use temporary folders).
- [ ] **Step 6: Report (no commit).**

---

## Spec coverage

| Spec step (Part 1) | Task |
|---|---|
| 1 mutex | 4 |
| 2 disk guard | 4 |
| 3 local tool, start, known task | 5 |
| 4 `process-new-orders` without `--push`, readiness at push time | 5, 6 |
| 5 name guards ("No", box, safe; no geometry → warning) | 1, 2, 3, 6 |
| 6 push passing AUTO lines under `.push-lock` | 6, 7 |
| 7 `/hold` when configured, else log | 7 |
| 8 log, JSON summary, 30 days, exit code | 4, 7 |
| `install-task.ps1`, not run by the build | 8 |
| Testing: geometry and "No" guard on fixture images | 1, 2, 3 |
