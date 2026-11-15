# Artwork Delivery API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let local machines deliver finished print files and mockups to prod through token-guarded HTTP routes instead of SSH + raw SQL, so no `.push-lock` is needed and no machine holds the VPS root key or the Drive refresh token.

**Architecture:** The local machine asks the server for a task's state, uploads files to a per-task Drive "incoming" folder with a short-lived access token from the server, then calls `commit`. The server validates, writes `DesignArtwork` / `DesignTask` / `DesignTaskEvent` rows through app code, then lets the existing `tidyTaskFolder` move files into the task folder and retired files to `_old`. Commits are serialised in-process with a memory guard.

**Tech Stack:** Next.js 14 App Router (route handlers), TypeScript, Prisma 7 + SQLite, vitest (`test.db`), Google Drive REST v3; Node ESM scripts (`.mjs`) on the local machine.

**Spec:** `docs/superpowers/specs/2026-11-15-artwork-delivery-api-design.md` (approved by the owner 2026-11-15). Read it before any task; section numbers below refer to it.

## Global Constraints

- Server work on a new worktree from `origin/main` (044ef7e or newer), branch `feat/delivery-api`. Never edit server code in the main checkout (stale branch, shared with other sessions).
- Every route lives under `/api/design-studio/worker/delivery/` (already `PUBLIC` in `src/lib/api-access.ts:76`; nginx allows 1100 MB / 900 s there). Each route checks `verifyWorkerRequest(req)` (`src/lib/artwork-worker.ts:30`) and the switch `AppSetting delivery.api.enabled` = `'true'`.
- No schema change, no migration.
- Tests never touch `dev.db`; Drive is always a fake in tests (inject `DeliveryDrive`, Task 2).
- `import { prisma } from '@/lib/db'`; never `@/generated/prisma` directly.
- New rows: `storage='DRIVE'`, `storagePath=NULL`, `source='AUTO'`, `uploadedById=NULL`. Event `actorId=NULL`.
- Default `retireSources = ['AUTO']`. A retired file is never deleted or trashed.
- Commit queue gap 300 ms; refuse with 503 + `Retry-After: 60` when process RSS > 1100 MB or `os.freemem()` < 600 MB.
- Incoming folder path `<Design Studio root>/_incoming/<taskKey>`; files there older than 7 days are deleted.
- Preview upload cap 4 MB (`src/lib/design-storage.ts:202`), only for files ≥ 30 MB.
- Client retry: honour `Retry-After`, give up after 30 minutes total, keep the ledger.
- Client parallel Drive uploads: default 3. Commits from one machine: one at a time.
- User-facing strings (errors returned to the tool UI, events) in Vietnamese, matching the existing ones.

## Review Focus

1. A commit retried after its response was lost, carrying the old `expected` → must return `alreadyApplied: true`, never 409 (test in Task 4).
2. Two machines commit the same task at the same moment → exactly one insert set, the other gets 409 (test in Task 6).
3. Retiring a no-custom print that other lines still use (`shortcutOf`) → the original file is never moved; only this line's shortcut goes to `_old` (test in Task 5).
4. Replacing a file that is the factory link (`OrderLine.designDriveLink` points at it) → old file still exists on Drive, just in `_old`; `deleteFile` is never called on retire (test in Task 5).
5. Order closed or task cancelled between `GET tasks/[key]` and `commit` → 409, nothing written (test in Task 4).

## File Structure

Server (`feat/delivery-api` worktree):
- `src/lib/delivery/types.ts` — request/response types shared by routes and tests.
- `src/lib/delivery/guard.ts` — token + switch check for every route.
- `src/lib/delivery/drive.ts` — `DeliveryDrive` interface and the real implementation (wraps `google-drive.ts` / `task-folder.ts`).
- `src/lib/delivery/task-state.ts` — builds the `GET tasks/[key]` payload.
- `src/lib/delivery/commit.ts` — validation order and the four actions.
- `src/lib/delivery/queue.ts` — in-process serial queue + memory guard.
- `src/lib/delivery/incoming.ts` — incoming folder cleanup.
- `src/lib/google-drive.ts` — add `getAccessTokenInfo`, `createShortcut`, `findShortcut`, `listChildren`.
- Routes: `src/app/api/design-studio/worker/delivery/{drive-token,tasks/[key],tasks/[key]/commit,artworks/[id]/preview}/route.ts`.
- `scripts/vps/hourly-backup.sh` — VPS cron script (installed only at deploy, owner's go-ahead).
- Tests: `tests/delivery-*.test.ts`, `tests/helpers/delivery-fake-drive.ts`.

Client (tool worktree `.claude/worktrees/peaceful-villani-d3d860`, where the push scripts live; they are **not on origin/main** and the worktree has uncommitted edits — see Task 9 step 1):
- `scripts/lib/delivery-client.mjs` — HTTP client + retry.
- `scripts/lib/push-local-renders.mjs`, `scripts/push-local-renders.mjs`, `scripts/push-shared-prints.mjs` — `--via api|ssh`.
- `scripts/lib/drive-rest.mjs` — accept an access-token provider.

Callers: `tools/auto-render-hourly/auto_render.py` (origin/main), `D:\Ecom manager\artwork-builder\p2\s2\push_s2n.sh`, `...\c1112\REJECTED\push_core.sh`.

---

### Task 1: Route guard, switch and shared types

**Files:**
- Create: `src/lib/delivery/types.ts`, `src/lib/delivery/guard.ts`
- Test: `tests/delivery-guard.test.ts`

**Interfaces:**
- Produces:
  - `DELIVERY_SWITCH_KEY = 'delivery.api.enabled'`
  - `requireDeliveryWorker(req: NextRequest): Promise<NextResponse | null>` — `null` when allowed; 401 `{ error: 'Unauthorized' }` without a valid worker token; 503 `{ error: 'Giao file qua API đang tắt', code: 'disabled' }` when the switch is not `'true'`.
  - Types in `types.ts`: `DeliveryAction = 'push' | 'replace' | 'retire' | 'revert'`; `DeliveryFile = { kind: 'PRINT' | 'MOCKUP'; printArea: string; fileName: string; driveFileId: string; shortcutOf?: string | null; size: number; mimeType: string; widthPx?: number | null; heightPx?: number | null }`; `CommitInput = { action; expected: { status: string; liveIds: string[] }; files: DeliveryFile[]; retire: string[]; retireSources?: ('AUTO' | 'MANUAL')[]; allowFinished?: boolean; revertReadiness?: 'MANUAL' | 'LOW'; eventMessage?: string; dryRun?: boolean }`; `CommitResult = { ok: true; status: string; artworks: { id: string; kind: string; printArea: string; version: number }[]; retired: string[]; missing: string[]; warnings: string[]; alreadyApplied: boolean }`; `CommitError = { ok: false; error: string; code: string; httpStatus: 400 | 404 | 409 | 503; current?: TaskState }`; `TaskState` exactly as listed under Task 3 (defined here so every later file imports it from `types.ts`).

- [ ] **Step 1: Write failing tests** `requireDeliveryWorker`: no header → 401; valid token + switch missing → 503 with `code: 'disabled'`; valid token + switch `'true'` → `null`; wrong token + switch on → 401. Generate the token with `generateWorkerToken()`.
- [ ] **Step 2: Run** `npx vitest run tests/delivery-guard.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `types.ts` and `guard.ts` (read the switch with `prisma.appSetting.findUnique`).
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery): worker guard, switch and types`.

### Task 2: Drive helpers and the injectable `DeliveryDrive`

**Files:**
- Modify: `src/lib/google-drive.ts` (add exports next to `placeFile`, ~line 312)
- Create: `src/lib/delivery/drive.ts`, `tests/helpers/delivery-fake-drive.ts`
- Test: `tests/google-drive.test.ts` (extend), `tests/delivery-fake-drive.test.ts`

**Interfaces:**
- Produces in `google-drive.ts`:
  - `getAccessTokenInfo(): Promise<{ accessToken: string; expiresAt: string }>` (same cache as `getAccessToken`, ISO expiry).
  - `createShortcut(targetId: string, parentId: string, name: string): Promise<string>` — POST `files` with `mimeType: 'application/vnd.google-apps.shortcut'`, `shortcutDetails.targetId`; returns new id.
  - `findShortcut(parentId: string, targetId: string): Promise<string | null>` — query `'<parent>' in parents and mimeType='application/vnd.google-apps.shortcut' and trashed=false`, fields `files(id,shortcutDetails)`, match `targetId`.
  - `listChildren(parentId: string): Promise<{ id: string; name: string; mimeType: string; createdTime: string }[]>` (pages through `nextPageToken`).
- Produces in `delivery/drive.ts`:
  ```ts
  export type DriveFileInfo = { id: string; size: number; parents: string[]; trashed: boolean; mimeType: string }
  export type DeliveryDrive = {
    fileInfo(id: string): Promise<DriveFileInfo | null>          // null on 404
    taskFolder(orderId: string, shopifyLineId: string): Promise<{ id: string; url: string }>   // ensureTaskFolder
    incomingFolder(taskKey: string): Promise<string>             // folderForPath(['_incoming', taskKey]) under the root
    oldFolder(orderId: string, shopifyLineId: string): Promise<string>   // oldFolderFor
    createShortcut(targetId: string, parentId: string, name: string): Promise<string>
    findShortcut(parentId: string, targetId: string): Promise<string | null>
    moveFile(id: string, folderId: string, name: string): Promise<void>  // placeFile
    tidy(orderId: string, shopifyLineId: string): Promise<void>  // tidyTaskFolder, errors logged not thrown
    listChildren(parentId: string): ReturnType<typeof listChildren>
    deleteFile(id: string): Promise<void>                        // only Task 8 may call it
  }
  export const realDeliveryDrive: DeliveryDrive
  export function getDeliveryDrive(): DeliveryDrive            // realDeliveryDrive unless a test set one
  export function setDeliveryDriveForTests(d: DeliveryDrive | null): void
  ```
  Every route takes its drive from `getDeliveryDrive()`.
- Produces in `tests/helpers/delivery-fake-drive.ts`: `fakeDrive(): DeliveryDrive & { files: Map<string, DriveFileInfo & { name: string }>; calls: string[]; addFile(f: Partial<DriveFileInfo> & { id: string; parent: string; size: number }): void }` — in-memory, records every call as `'<method>:<args>'`.

- [ ] **Step 1: Write failing tests** in `tests/google-drive.test.ts` with the existing `mockFetch` helper: `createShortcut` posts the shortcut mime type and `shortcutDetails.targetId`; `findShortcut` returns the id whose `shortcutDetails.targetId` matches and `null` otherwise; `listChildren` follows `nextPageToken` across two pages; `getAccessTokenInfo` returns the primed token and an ISO `expiresAt` in the future.
- [ ] **Step 2: Write failing test** `tests/delivery-fake-drive.test.ts`: `moveFile` changes `parents`; `fileInfo` of an unknown id is `null`; every call is in `calls`.
- [ ] **Step 3: Run** both — expect FAIL.
- [ ] **Step 4: Implement** the four helpers, `delivery/drive.ts`, and the fake.
- [ ] **Step 5: Run** — expect PASS. Also run `npx vitest run tests/google-drive.test.ts tests/task-folder*.test.ts` to see nothing else broke.
- [ ] **Step 6: Commit** `feat(delivery): Drive shortcut/list helpers and injectable DeliveryDrive`.

### Task 3: Task state (`GET tasks/[key]`)

**Files:**
- Create: `src/lib/delivery/task-state.ts`, `src/app/api/design-studio/worker/delivery/tasks/[key]/route.ts`
- Test: `tests/delivery-task-state.integration.test.ts`

**Interfaces:**
- Consumes: `DeliveryDrive` (Task 2), `requireDeliveryWorker` (Task 1), `requiredSlotsForLine` (`src/lib/design-tasks.ts:1313`), `isSentLineOfOpenOrder` (`:504`), `isOrderOpen` (`src/lib/design-agent/order-open.ts`).
- Produces (type lives in `types.ts`, Task 1): `type TaskState = { taskKey: string; status: string; readiness: string; orderOpen: boolean; sent: boolean; folder: { id: string; url: string }; incomingFolder: { id: string }; artworks: { id: string; kind: string; printArea: string; version: number; source: string; uploadedById: string | null; driveFileId: string | null; sharedWith: number }[]; nextVersion: Record<string, number>; required: string[] }` and `deliveryTaskState(taskKey: string, drive: DeliveryDrive): Promise<TaskState | null>`.
- `nextVersion` keys are `` `${kind}/${printArea}` `` for every part that has any row (live or removed), value = max(version) + 1. `sharedWith` = count of live rows with the same `driveFileId` on other lines.

- [ ] **Step 1: Write failing tests** (fixture: `agentFixture('DLS')` from `tests/helpers/design-agent-fixture.ts`, template with areas Front/Back like `tests/design-agent-delivery.integration.test.ts`): a NEW task with no files → `artworks: []`, `required: ['Front','Back']`, folder and incoming folder created once (fake records one `taskFolder` and one `incomingFolder` call); a line with Front v1 removed and Front v2 live → `nextVersion['PRINT/Front'] === 3`; a print whose `driveFileId` is live on another line → `sharedWith === 1`; unknown key → `null`; route returns 404 for unknown key and 200 with the payload otherwise (call the route's `GET` with a `NextRequest` carrying the bearer token, switch on).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `deliveryTaskState` and the route (`export const dynamic = 'force-dynamic'`; the route passes `getDeliveryDrive()`; tests call `setDeliveryDriveForTests(fakeDrive())`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery): task state route`.

### Task 4: Commit — checks, `push`, idempotency

**Files:**
- Create: `src/lib/delivery/commit.ts`
- Test: `tests/delivery-commit-push.integration.test.ts`

**Interfaces:**
- Consumes: `TaskState`/`deliveryTaskState` (Task 3), `DeliveryDrive` (Task 2), `submitAutoRenderForReview` (`src/lib/design-tasks.ts:827`), `templateForLine` (`:1306`), `printFileFit` (`src/lib/print-file-fit.ts:26`), `driveFileName` (`src/lib/task-files.ts:153`).
- Produces: `commitDelivery(taskKey: string, input: CommitInput, drive: DeliveryDrive): Promise<CommitResult | CommitError>`. Task 5 adds the other actions inside the same function; Task 6 wraps it in the queue.

Check order (spec 7.3), each failure returns a `CommitError` and writes nothing:
1. Task missing → 404 `not_found`. Order closed or task `CANCELLED` → 409 `closed`.
2. **Already applied:** every file's `driveFileId` is already a live row at the same `kind/printArea` and every `retire` id is already removed → `{ ok: true, alreadyApplied: true, ... }` with the current rows. Runs before step 3.
3. `expected.status` ≠ current status, or `expected.liveIds` (sorted) ≠ current live ids (sorted, PRINT and MOCKUP) → 409 `stale` with `current`.
4. Per file: `fileInfo` null or `trashed` → 400 `drive_missing`; `size` mismatch → 400 `size_mismatch`; parents contain neither the incoming folder nor the task folder → 400 `wrong_folder`. With `shortcutOf`: the target must be a live PRINT on another line (else 400 `bad_shortcut`).
5. Old layout: `printFileFit(template, printArea, { widthPx, heightPx, createdAt: now })` is `bad` but would be `ok` with `createdAt` before the alt set's `filesUntil` → 400 `old_layout`. Any other `bad` → push a Vietnamese line into `warnings`, continue.
6. `dryRun` → return what would be written (`ok: true`, versions computed), no writes, no Drive changes.

`push` (task in NEW/ASSIGNED/DOING/REJECTED, no live PRINT; otherwise 409 `wrong_state`):
- One `prisma.$transaction`: insert each file with server `id` (cuid), `version = nextVersion` for its part, `createdAt = now`, `drivePlace = NULL` for uploaded files (so `tidy` moves them) or `'TASK'` for `shortcutOf` files after `createShortcut(target, taskFolder, driveFileName(...))` (row `driveFileId = shortcutOf`); one ARTWORK event: `eventMessage` or `Render tự động · <made>` built like `lineStatements` in `scripts/lib/push-local-renders.mjs` (one part: `"<area> v<n> · <w>×<h> px"`, several: `"<n> mảnh: <area> v<n>, …"`, plus `" · <k> mockup"`).
- After the transaction: `submitAutoRenderForReview(orderId, shopifyLineId)`; when it does not move, `missing` = required parts without a live PRINT and the task keeps its status. Then `drive.tidy(orderId, shopifyLineId)`.

- [ ] **Step 1: Write failing tests**, each on a fresh fixture line, fake Drive with the uploaded files placed in the incoming folder:
  - `push` with Front + Back on a NEW task → two rows `source 'AUTO'`, `storage 'DRIVE'`, versions 1, task `REVIEW` / readiness `AUTO`, events ARTWORK `"Render tự động · 2 mảnh: Front v1, Back v1"` then SYSTEM `AUTO_REVIEW_MESSAGE`; fake `calls` contains `tidy`.
  - `push` with Front only → one row, task stays `NEW`, `missing: ['Back']`.
  - same request sent twice, second time with the stale `expected` (`status: 'NEW', liveIds: []`) → second result `alreadyApplied: true`, still exactly two rows. *(Review Focus 1)*
  - `expected.status: 'NEW'` while task is `DOING` and no files match → 409 `stale` with `current.status === 'DOING'`.
  - file not in incoming or task folder → 400 `wrong_folder`; trashed file → 400 `drive_missing`; size 1 byte off → 400 `size_mismatch`; nothing written in any of the three.
  - order with `closedAt`/cancelled task → 409 `closed`, nothing written. *(Review Focus 5)*
  - template with an alt set `filesUntil: '2026-11-01'` and a file sized to that alt set → 400 `old_layout`.
  - `dryRun: true` → `ok: true`, versions in the result, zero new rows, fake `calls` has no `moveFile`/`createShortcut`.
  - `shortcutOf` pointing at another line's live print → row `driveFileId` = target, `drivePlace 'TASK'`, one `createShortcut` call, target never moved.
- [ ] **Step 2: Run** `npx vitest run tests/delivery-commit-push.integration.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the checks and `push` in `commit.ts`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery): commit checks and push`.

### Task 5: Commit — `replace`, `retire`, `revert`

**Files:**
- Modify: `src/lib/delivery/commit.ts`
- Test: `tests/delivery-commit-replace.integration.test.ts`

**Interfaces:**
- Consumes: `commitDelivery` internals from Task 4.
- Produces: the same `commitDelivery` handling the remaining actions.

Rules (spec 7.3):
- Retiring a row: `removedAt = now`, `removedById = NULL`; a row whose source is not in `retireSources` → 409 `not_retirable`. Retired rows with `sharedWith > 0`: `findShortcut(taskFolder, driveFileId)` → `moveFile(shortcutId, oldFolder, driveOldFileName(row))`, set `drivePlace = 'OLD'` in the transaction; the original is never moved. Other retired rows keep `drivePlace` and are moved by `drive.tidy`. `deleteFile` is never called.
- `replace`: allowed in REVIEW, DOING, REJECTED; DONE only with `allowFinished` (else 409 `wrong_state`). Retire `retire` ids, insert files as in `push`, ARTWORK event `eventMessage ? "<eventMessage> · thay <gone>" : "Thay file tự động · <made> · thay <gone>"` (`<gone>` = `"<area> v<n>, …"`). From REJECTED/DOING: after the transaction call `submitAutoRenderForReview`; when it moves, add an ARTWORK event `"Gửi duyệt lại"`. REVIEW/DONE keep their status.
- `retire`: like `replace` with no files; if no live PRINT would remain → 409 `last_print`.
- `revert`: only REVIEW + readiness AUTO + every live PRINT `source 'AUTO'` (else 409 `wrong_state`); retire all live PRINT and MOCKUP rows, set `status 'NEW'`, `readiness = revertReadiness ?? 'MANUAL'`, `prevStatus NULL` with `updateMany where status 'REVIEW'` (count 0 → 409 `stale`), one SYSTEM event `"Rút render tự động: gỡ <gone>"`.
- Every action ends with `drive.tidy`.

- [ ] **Step 1: Write failing tests:**
  - REVIEW line with Front v1 AUTO → `replace` Front → Front v1 removed, Front v2 live, status `REVIEW`, event `"Thay file tự động · Front v2 · … · thay Front v1"`.
  - REJECTED line → `replace` → status `REVIEW`, events include `"Gửi duyệt lại"`.
  - DONE line without `allowFinished` → 409 `wrong_state`; with it → replaced, status stays `DONE`.
  - retire a `source 'MANUAL'` row with default `retireSources` → 409 `not_retirable`; with `['AUTO','MANUAL']` → retired.
  - `retire` the only PRINT → 409 `last_print`.
  - retire a row whose `driveFileId` is live on a second line → fake `calls` has `findShortcut` and `moveFile:<shortcutId>`, never `moveFile:<original>`; row `drivePlace 'OLD'`. *(Review Focus 3)*
  - replace a row whose file is the line's `designDriveLink` → no `deleteFile` in `calls`, old file still in the fake's `files`. *(Review Focus 4)*
  - `revert` on REVIEW/AUTO → all prints removed, status `NEW`, readiness `MANUAL`; `revert` on a line with a MANUAL print → 409 `wrong_state`.
  - **Parity:** build the same push-from-NEW and replace-in-REVIEW lines with `lineStatements` from the client lib (copy the function's expected event strings, do not import across repos) and assert the server rows/events match except `id`, `createdAt`, `previewPath`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** this file and Task 4's file — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery): replace, retire and revert`.

### Task 6: Queue, memory guard and the commit route

**Files:**
- Create: `src/lib/delivery/queue.ts`, `src/app/api/design-studio/worker/delivery/tasks/[key]/commit/route.ts`
- Test: `tests/delivery-commit-route.integration.test.ts`

**Interfaces:**
- Consumes: `commitDelivery` (Tasks 4–5), `requireDeliveryWorker` (Task 1).
- Produces:
  - `runSerial<T>(fn: () => Promise<T>, opts?: { gapMs?: number }): Promise<T>` — one promise chain on `globalThis.__deliveryQueue`, `gapMs` default 300 between runs; a failing run does not break the chain.
  - `memoryPressure(sample?: { rss: number; free: number }): { retryAfterSec: number } | null` — defaults `process.memoryUsage().rss`, `os.freemem()`; thresholds 1100 MB / 600 MB.
  - Route `POST` → 503 + `Retry-After: 60` under pressure; otherwise `runSerial(() => commitDelivery(key, body, getDeliveryDrive()))`; `CommitError` → its `httpStatus` with `{ error, code, current? }`; success → 200 `CommitResult`. Malformed body → 400 `bad_request`.

- [ ] **Step 1: Write failing tests:** `runSerial` runs three jobs in order with ≥ 300 ms between starts (fake timers); a rejected job does not stop the next; `memoryPressure({ rss: 1200e6, free: 2e9 })` → `{ retryAfterSec: 60 }`, `({ rss: 500e6, free: 500e6 })` → not null, `({ rss: 500e6, free: 2e9 })` → null; route with two concurrent `POST` push requests for the same NEW task (`Promise.all`) → one 200, one 200 with `alreadyApplied` or 409 `stale`, exactly one row per part *(Review Focus 2)*; route without token → 401.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** (route test uses the real queue and `setDeliveryDriveForTests(fakeDrive())`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery): serial commit route with memory guard`.

### Task 7: Drive token and preview routes

**Files:**
- Create: `src/app/api/design-studio/worker/delivery/drive-token/route.ts`, `src/app/api/design-studio/worker/delivery/artworks/[id]/preview/route.ts`
- Test: `tests/delivery-token-preview.integration.test.ts`

**Interfaces:**
- Consumes: `getAccessTokenInfo` (Task 2), `requireDeliveryWorker` (Task 1); the preview save helper already behind `design-storage.ts:224` (`previewPath` update).
- Produces: `POST drive-token` → `{ accessToken, expiresAt }` (503 `drive_not_connected` when Drive is not connected); `PUT artworks/[id]/preview` with a JPEG body → `{ ok: true, previewPath }`; refuses non-JPEG (400), > 4 MB (413), an artwork that is removed or not `source 'AUTO'` (409), unknown id (404).

- [ ] **Step 1: Write failing tests** for each status above; the token test primes the cache with `primeAccessToken`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** (reuse the existing preview writer in `design-storage.ts`; do not invent a new path).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(delivery): drive token and preview routes`.

### Task 8: Incoming folder cleanup and the hourly DB backup script

**Files:**
- Create: `src/lib/delivery/incoming.ts`, `scripts/vps/hourly-backup.sh`
- Modify: `src/lib/drive-push-queue.ts` (call the cleanup once per scheduled run, after the tidy pass near line 116)
- Test: `tests/delivery-incoming.test.ts`

**Interfaces:**
- Produces: `cleanupIncoming(drive: DeliveryDrive, now?: Date): Promise<{ deletedFiles: number; removedFolders: number }>` — for each child folder of `_incoming`: delete files with `createdTime` older than 7 days, then remove the folder when it is empty. Runs at most once an hour (timestamp on `globalThis`).
- `hourly-backup.sh`: `VACUUM INTO /root/db-backups/dev-hourly-<UTC yyyymmddTHHMMSSZ>.db` through `python3` (read-only URI like `push_core.sh`), then keep the newest 30 `dev-hourly-*.db` and leave other backup names alone; exit non-zero and print to stderr if free disk < 2 GB before starting.

- [ ] **Step 1: Write failing tests:** a folder with one 8-day-old and one 1-day-old file → only the old one deleted, folder kept; an empty folder → removed; second call within the hour → no Drive calls.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `incoming.ts`, the hook, and the shell script (`bash -n scripts/vps/hourly-backup.sh` must pass).
- [ ] **Step 4: Run** the tests and `npx vitest run tests/drive-push-queue.integration.test.ts` — expect PASS.
- [ ] **Step 5: Run the full suite** `npm test` and `npx tsc --noEmit` — expect PASS.
- [ ] **Step 6: Commit** `feat(delivery): incoming cleanup and hourly backup script`.

### Task 9: Local client (`--via api`)

**Files (tool worktree `.claude/worktrees/peaceful-villani-d3d860`):**
- Create: `scripts/lib/delivery-client.mjs`
- Modify: `scripts/lib/drive-rest.mjs`, `scripts/lib/push-local-renders.mjs`, `scripts/push-local-renders.mjs`, `scripts/push-shared-prints.mjs`
- Test: `tests/delivery-client.test.ts`, extend `tests/push-local-renders.test.ts`

**Interfaces:**
- Consumes: the four routes (Tasks 3, 6, 7) and their JSON shapes from `src/lib/delivery/types.ts`.
- Produces:
  - `createDeliveryClient({ baseUrl, token, fetchImpl = fetch, sleep })` with `driveToken()`, `taskState(key)`, `commit(key, body)`, `putPreview(artworkId, jpegBuffer)`. Env defaults `ECOM_URL`, `DESIGN_WORKER_TOKEN`. Every call retries 503/429/network errors honouring `Retry-After`, total ≤ 30 minutes, then throws `DeliveryGaveUp`.
  - `createDriveClient(cfg, { accessToken?: () => Promise<string> })` — when the provider is given, no refresh token is read.
  - `runApiDelivery({ lines, client, drive, ledgerPath, log, uploads = 3 })` in `push-local-renders.mjs` lib: per line `taskState` → upload missing files to `incomingFolder` (ledger records `driveFileId` right after each upload) → `commit` with `expected` from the state → on 409 read `taskState` again and record the reason in the ledger as `skippedOnProd` (no Drive deletes) → `putPreview` for files ≥ 30 MB. A line already `applied` in the ledger is skipped.
  - Flags: `--via api|ssh` (default `ssh` until the rollout's step 5 flips it); `--revert` maps to action `revert`.

- [ ] **Step 1: Prepare the worktree.** The scripts exist only as uncommitted edits on a detached HEAD (0fa0186). Check `list_sessions` for a session using this worktree; if one is active, stop and ask the coordinator. Otherwise commit the current edits on a new branch `feat/delivery-client` ("wip: push scripts as of 2026-11-15") before changing anything.
- [ ] **Step 2: Write failing tests:** client retries a 503 with `Retry-After: 1` then succeeds; gives up after the 30-minute budget (fake `sleep`); `runApiDelivery` on a 409 re-reads state, records `skippedOnProd`, and calls no Drive delete; a second run with the same ledger uploads nothing and commits nothing for applied lines; a crash between upload and commit → second run commits without uploading again.
- [ ] **Step 3: Run** `npx vitest run tests/delivery-client.test.ts tests/push-local-renders.test.ts` — expect FAIL.
- [ ] **Step 4: Implement**.
- [ ] **Step 5: Run** the whole worktree suite `npm test` — expect PASS (the `--via ssh` path is unchanged).
- [ ] **Step 6: Commit** on `feat/delivery-client` `feat(push): deliver through the API with --via api`.

### Task 10: Deploy and rollout (owner checkpoints)

**Files:**
- Modify: `tools/auto-render-hourly/auto_render.py` (pass `--via api`, drop its `.push-lock` handling) on `feat/delivery-api`
- Modify: `D:\Ecom manager\artwork-builder\p2\s2\push_s2n.sh`, `D:\Ecom manager\artwork-builder\p2\s2\c1112\REJECTED\push_core.sh` (call with `--via api`; delete the snapshot/backup/scp/quarter-wait lines)
- Create: `docs/superpowers/plans/2026-11-15-artwork-delivery-api-rollout.md` (log of each step below with times and results)

- [ ] **Step 1: Deploy** `feat/delivery-api` (rebased on the newest `origin/main`, diff against the newest VPS `tmp/` candidate first) with the switch off. Check `/login` 200 and `POST /api/design-studio/worker/delivery/drive-token` → 503 `disabled`.
- [ ] **Step 2: Ask the owner** before installing `scripts/vps/hourly-backup.sh` in root's crontab (`0 * * * *`). Install only on a yes; run it once by hand and list `/root/db-backups`.
- [ ] **Step 3: Switch on** (`delivery.api.enabled = 'true'`), run 20 planned lines with `dryRun` through the client next to the old path; compare versions and actions; stop on any difference.
- [ ] **Step 4: Real run, 10 lines**, watched: each line has the files in its task folder, nothing left in `_incoming`, correct rows and events on the tool, PM2 restart count unchanged.
- [ ] **Step 5: Switch callers:** auto render hourly, then the two stream scripts; make `--via api` the default; remove `.push-lock` from the callers.
- [ ] **Step 6: Acceptance:** three streams deliver 50 lines at once — no waits, PM2 no restart, every task folder clean. Record in the rollout log.
- [ ] **Step 7: After 14 days without falling back**, ask the owner before removing `--via ssh`.
