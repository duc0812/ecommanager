# Design Tasks v2 — task-based studio with the approved workspace

**Status:** approved in chat 2026-10-10 from the HTML demo (`Design Task LIT4545_1`, artifact 3LjFpgzo5NDZBCHeQsj58M) and the 9Router screens. Runs local only.
**Builds on:** v1 spec `2026-10-09-design-studio-design.md` (persisted attributes, `DesignArtwork` keyed by `(orderId, shopifyLineId)`, local storage, `loadWorkspace`, `updateLine`, `applyLineProps`, `/api/design-studio/*`).

## Goal

Replace the v1 "order list → order page" with a Merchbridge-style **Design Tasks** screen: a queue on the left (one task per order line that needs a print file, task ID = `<order number>_<line position>`) and, on the right, the approved image-first workspace for the selected task. Tasks carry a lifecycle (new → assigned → doing → review → done, with reject / ask / cancelled branches), an assignee, KPI points and a deadline, so a Leader can run the team from one page.

Out of scope for v2: Google Drive storage, the local render worker / auto-design, the full Dashboard page, Print Template editor UI (only the data model and a seed).

## Data model

### `DesignTask`

| column | type | note |
|---|---|---|
| id | cuid | |
| orderId | FK Order, cascade | |
| shopifyLineId | String | the line, stable across re-sync |
| taskKey | String | `LIT4545_1` (order number without `#` + `_` + linePosition) |
| status | String | `NEW` · `ASSIGNED` · `DOING` · `REVIEW` · `REJECTED` · `ASK_CUSTOMER` · `DONE` · `CANCELLED` |
| readiness | String | `AUTO` · `LOW` · `MANUAL` (see Readiness) |
| assigneeId | String? | AppUser.id |
| kpi | Float | default from `DesignTaskSetting` by product type, else 0.3 |
| dueAt | DateTime? | set on assign or take: now + SLA hours |
| slaHours | Int | 24 custom / 48 non-custom (setting) |
| rejectReasons | String? | JSON array of strings |
| rejectNote | String? | |
| supplierSnapshot | String? | supplier name at creation (display) |
| createdAt / updatedAt | | |

Unique `[orderId, shopifyLineId]`. Index `[status]`, `[assigneeId]`.

### `DesignTaskEvent`

`id, taskId (FK cascade), type (SYSTEM|NOTE|STATUS|ASSIGN|UPLOAD|REJECT|ASK), message, actorId?, createdAt`. The feed in the workspace.

### `PrintTemplate` (data only in v2)

`id, supplierId (FK), supplierSku String?, name, widthPx, heightPx, dpi, bleedIn Float (0.125), safeIn Float (0.2), mirror Boolean, areas String (JSON [{name,x,y,w,h}]), guideImagePath String? (artguide PNG under storage), templateUrl String?, createdAt`. Unique `[supplierId, supplierSku]`. A seed script inserts the Merchize BAJE jersey (12289×5906, 150 dpi, the six demo panels) for the supplier matching code `MERCHIZE` if it exists, else skips.

### `DesignTaskSetting` → stored in `AppSetting` as `design.settings` JSON: `{ slaCustomHours: 24, slaNonCustomHours: 48, kpiByType: { jersey: 0.3, socks: 0.4, ornament: 0.2, tumbler: 0.15, default: 0.3 }, rejectReasons: [...6 strings] }`.

## Task creation and readiness

`syncDesignTasks(orderId)` runs at the end of every order sync (`/api/shopify/orders/sync`) and on demand (`POST /api/design-studio/tasks/sync?orderId=`):

- For each product line (`!isNonProductLine`) with `resolvedSupplierId` and no `designDriveLink` → upsert a task (`NEW` if new). Non-custom lines already satisfied by the Design Library have `designDriveLink` from sync and get no task.
- Lines whose order is cancelled/refunded → task `CANCELLED`.
- A line that gains `designDriveLink` outside the studio (Trello sync, library) → task `DONE` with a SYSTEM event "done outside studio".

Readiness per task: `AUTO` when a source print file exists (`_print_files`/`_customall_print_file`) **and** the line's supplier SKU has a `PrintTemplate` whose smallest area's longer side ≤ 1.2 × the source image's longer side (not computed in v2 — no image probing; so in v2: `AUTO` never, `LOW` when a source print file exists, `MANUAL` otherwise). Readiness is a column so the agent can set it later.

## Lifecycle

| from → to | who | trigger |
|---|---|---|
| NEW → ASSIGNED | Leader | assign form (assignee, kpi, dueAt, requirement note) |
| NEW/ASSIGNED → DOING | Designer | "Nhận việc" (sets assignee = self if empty, dueAt if empty) |
| ASSIGNED → NEW | Designer | "Từ chối" (clears assignee, event) |
| DOING/REJECTED → REVIEW | Designer | "Gửi duyệt" — requires at least one artwork per print area |
| REVIEW → DONE | Leader (or designer when readiness AUTO) | "Duyệt & gửi xưởng" → calls v1 `updateLine(done:true)` (sets `designDriveLink`, recomputes order) |
| REVIEW → REJECTED | Leader | reasons (multi-select from settings) + note |
| any open → ASK_CUSTOMER | Designer/Leader | "Hỏi khách" with a note; CS answers in the feed; "Tiếp tục" returns to previous status |
| DONE → DOING | anyone | "Sửa & gửi lại" → `updateLine(done:false)` |
| open → CANCELLED | system | order cancelled |

Roles: `SUPERADMIN`/`ADMIN` act as Leader; `SELLER`/`SUPPORT` with the design permission act as Designer. A new feature permission `design_tasks` (label "Design Tasks", path `/design-studio`) replaces the v1 mapping under `fulfillment_design_library`; ADMIN gets it by default.

## Pages

### `/design-studio` — Design Tasks (replaces the v1 list)

Two columns (left 290px sticky queue, right workspace), exactly the approved demo:

**Queue:** search (task key, SKU, product, personalization values), readiness chips (Tất cả / Tự động / Cần chỉnh / Làm tay), "Của tôi" toggle, sections in order *Bị trả lại → Hỏi khách → Mới / Đã giao → Đang làm → Chờ duyệt → Xong hôm nay*, each row: thumbnail (preview), task key, time left (red when overdue), short product name · variant, readiness pill, status pill, assignee avatar. Sorted by least time left.

**Workspace header:** task key, status pill, readiness pill, time-left pill, product title; meta row (order, store, SKU, supplier, KPI, assignee, source engine); **personalization table** (`# · Trường · Giá trị (copy) · Layer · Biến thể`, non-ASCII and long-value badges); action row (role-aware per the lifecycle); Leader assign form; reject panel with reason chips.

**Image row (`2.1fr 1fr 1fr`, each pane expandable):**
1. *File in trên template* — SVG canvas from the line's `PrintTemplate` (areas as grey panels, bleed/safe dashed lines, artguide image overlay with opacity slider, background switch), the newest artwork of each area drawn inside its panel, the source print file drawn into the first area when no artwork exists (with the scale factor label). No template → a placeholder with "Chưa có template cho SKU này" and a link to add one later.
2. *Khách đã thấy* — `previewUrl`.
3. *Mockup xưởng* — the source print files / newest artwork; front/back toggle when the template has areas named Front*/Back*.

**Lower grid:** Artwork theo panel (slots per template area, else per `printAreasForLine`, versions, drag-drop upload — v1 route), Xưởng & template (supplier, template, master artwork, library, customer links), Yêu cầu xưởng ↔ file (template px/dpi/bleed vs newest artwork's px, from image headers read at upload time — add `widthPx/heightPx` to `DesignArtwork`), Checklist (5 items, machine-ticked ones from the readiness/size checks), Trao đổi & lịch sử (events + composer).

### `/design-studio/[orderId]` (v1 page)

Kept as a redirect to `/design-studio?task=<first task key of the order>`.

## API (all under `/api/design-studio`, rule `['design_tasks']` added; the v1 rule stays)

| method & path | does |
|---|---|
| `GET /tasks?status=&readiness=&mine=1&q=` | queue rows (slim) |
| `GET /tasks/[key]` | task + the v1 `WorkspaceLine` for its line + template + events + assignable users |
| `POST /tasks/[key]/transition` | `{ to, note?, reasons?, assigneeId?, kpi?, dueHours? }` — validates per lifecycle, writes an event, calls `updateLine` on DONE / reopen |
| `POST /tasks/[key]/events` | `{ message }` note |
| `POST /tasks/sync` | `{ orderId? }` run `syncDesignTasks` for one order or all open orders |
| `GET /templates?supplierId=&sku=` · `POST /templates` | read / upsert PrintTemplate (data only, used by the seed and tests) |
| `GET /settings` · `PUT /settings` | design settings (PUT superadmin) |

## Server logic — `src/lib/design-tasks.ts`

`taskKeyFor(orderNumber, linePosition)`, `syncDesignTasks(orderId)`, `transitionTask(key, actor, input)` (pure guard `canTransition(status, to, role)` exported and unit-tested), `listTasks(filter)`, `loadTask(key)` (reuses `loadWorkspace` and picks the line), `templateForLine(line)`.

## Tests

Vitest on test.db: `taskKeyFor`; `canTransition` matrix (every row of the lifecycle table plus two forbidden moves); `syncDesignTasks` creates NEW for a mapped custom line, none for a line with `designDriveLink`, CANCELLED on a cancelled order, idempotent on re-run; `transitionTask` to DONE sets `designDriveLink` and the order leaves PENDING_DESIGN; REJECTED stores reasons; ASK_CUSTOMER then continue restores the previous status; `GET /tasks` filters by status and `mine`; image header probe records width/height on upload.

## Known limitations

Local storage and app URLs in the supplier CSV (unchanged from v1). Readiness `AUTO` is never produced in v2. Mockup pane shows images, not a rendered garment.
