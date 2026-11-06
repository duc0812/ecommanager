# Scale Product Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/tools/scale` page where staff upload one product image, pick a target product, and get a mockup of the same design on the target, generated through Kie.

**Architecture:** New `src/lib/scale/*` module beside `src/lib/creative/*`. A job runs a two-step pipeline in-process (vision model writes the design description → prompt assembled from frame + target blank description + design → Kie image task), then is polled like a Creative job. Targets (blank image + description) are rows managed by superadmin on the same page.

**Tech Stack:** Next.js 14 app router, Prisma 7 + SQLite, Tailwind tokens, vitest, zod. Kie: `/api/v1/jobs/*` for images (existing `kieClient`), `/openai/v1/responses` with `input_image` for vision (probed live 11/06/2026: works with `gpt-6.1-sol`, data-URL image, 7 s).

**Spec:** `docs/superpowers/specs/2026-11-06-scale-product-tool-design.md`

## Global Constraints

- Worktree `D:\Ecom manager\wt-scale-tool`, branch `feat/scale-product-tool`. Never commit on `main`; no push/deploy without the owner.
- Pages: `'use client'`, `<Sidebar />`, Tailwind tokens, `material-symbols-outlined`, no code comments unless a non-obvious constraint. UI text Vietnamese, dates `MM/DD/YYYY` (`en-US`).
- Every `/api/tools/scale/*` route has a rule in `API_ACCESS_RULES`; target/settings writes also call `requireSuperadmin`. Routes excluded from the middleware matcher call `requireApiAccess`.
- Keys never returned unmasked. Server-side downloads go through `assertSafeExternalUrl`.
- Schema change: migration folder written from `prisma migrate diff` SQL by hand (CLI is silent here), `prisma generate`, `SCHEMA_VERSION` `'v77'` → `'v78'`.
- Tests: `test.db` only, own fixtures, fake fetch / fake Kie. Run with `npx vitest run <file>`.
- Lint changed files: `npx eslint --ext .ts,.tsx <files>`; types: `npx tsc --noEmit`.
- Upload names sent to Kie are unique per job: `scale-<jobId>-src.<ext>`, `scale-<jobId>-blank.<ext>`.
- Fallback model is used only through the explicit fallback action and only when `allowFallback` is on.

## Review Focus

1. Source image has no back view → prompt must not invent a back graphic (`back` continues the base pattern). Test in Task 2.
2. Target picked by a stale page after superadmin deactivated it or removed its blank → 400 "Sản phẩm đích chưa sẵn sàng", no Kie call. Test in Task 6.
3. Kie 401 "not authorized to use this model" on the image step vs the vision step → message names the right key (Creative vs CS) and the slug. Test in Task 6.
4. Process restart mid-`describing` → job fails after 5 min instead of spinning forever. Test in Task 6.
5. Staff presses the fallback action while `allowFallback` is off (crafted request) → 400, no task created. Test in Task 6.

---

### Task 1: Permission, nav, access rules, schema

**Files:**
- Modify: `src/lib/roles.ts` (add `tools_scale` everywhere `tools_creative` appears: union, label `'Scale sản phẩm'`, Tools group, ADMIN defaults, path `['/tools/scale']`, the list near line 211)
- Modify: `src/components/Sidebar.tsx` (child `{ href: '/tools/scale', icon: 'swap_horiz', label: 'Scale sản phẩm' }` after Creative)
- Modify: `src/lib/api-access.ts`, `src/lib/api-access.test.ts`, `src/middleware.ts`
- Modify: `prisma/schema.prisma`, `src/lib/db.ts`; Create: `prisma/migrations/20261106120000_scale_tool/migration.sql`

**Interfaces — Produces:** permission `'tools_scale'`; Prisma models:

```prisma
model ScaleTarget {
  id               String   @id @default(cuid())
  name             String
  sku              String   @unique
  blankFile        String?
  blankDescription String   @default("")
  unprintedParts   String   @default("")
  active           Boolean  @default(false)
  sortOrder        Int      @default(0)
  candidateFile    String?
  candidateTaskId  String?
  candidateStatus  String?
  candidateError   String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}

model ScaleJob {
  id             String    @id @default(cuid())
  targetId       String
  targetName     String
  model          String
  status         String    @default("describing")
  designJson     String?
  prompt         String?
  sourceFile     String?
  resultFile     String?
  providerTaskId String?
  resultUrl      String?
  error          String?
  cost           String?
  durationMs     Int?
  parentJobId    String?
  createdBy      String?
  createdAt      DateTime  @default(now())
  completedAt    DateTime?
  @@index([createdAt])
}
```

- [ ] **Step 1:** Add to `api-access.test.ts`:

```ts
it('scale tool: staff with tools_scale can run jobs and read targets; target and settings writes are superadmin-only', () => {
  expect(canCallApi('SELLER', ['tools_scale'], '/api/tools/scale/jobs', 'POST')).toBe('ok')
  expect(canCallApi('SELLER', ['tools_scale'], '/api/tools/scale/targets', 'GET')).toBe('ok')
  expect(canCallApi('ADMIN', ['tools_scale'], '/api/tools/scale/targets', 'POST')).toBe('forbidden')
  expect(canCallApi('ADMIN', ['tools_scale'], '/api/tools/scale/settings', 'POST')).toBe('forbidden')
  expect(canCallApi('SUPERADMIN', [], '/api/tools/scale/targets', 'POST')).toBe('ok')
  expect(canCallApi('SELLER', DEFAULT_ROLE_PERMISSIONS.SELLER, '/api/tools/scale/jobs', 'GET')).toBe('forbidden')
  expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/tools/scale/jobs', 'GET')).toBe('ok')
})
```

- [ ] **Step 2:** Run `npx vitest run src/lib/api-access.test.ts` → the new test fails.
- [ ] **Step 3:** Add rules (before any broader `/api/tools` rule): targets WRITE → `'SUPERADMIN'`, settings WRITE → `'SUPERADMIN'`, `/api/tools/scale` → `['tools_scale']`. Add `tools_scale` to roles and the Sidebar. Add `api/tools/scale/jobs|api/tools/scale/targets` to the middleware matcher exclusion.
- [ ] **Step 4:** Add the two models; write the migration SQL from `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, then append 14 seed rows: `INSERT INTO "ScaleTarget" ("id","name","sku","sortOrder","updatedAt") VALUES ('scale_<SKU lower>', '<name>', '<SKU>', <n>, CURRENT_TIMESTAMP)` for the spec's table in order (FEHOVN=1 … KNCAVN=14). Apply to the worktree `dev.db` (`npx prisma db execute --file …` + `_prisma_migrations` row), `npx prisma generate`, bump `SCHEMA_VERSION`.
- [ ] **Step 5:** `npx vitest run src/lib/api-access.test.ts` → pass (global setup rebuilding `test.db` proves the migration). Commit `feat(scale): permission, access rules and tables for the scale product tool`.

### Task 2: Prompt assembly

**Files:** Create `src/lib/scale/prompt.ts`, `tests/scale-prompt.test.ts`

**Interfaces — Produces:**

```ts
export const DesignSchema: z.ZodType<Design>
export type Design = { sourceGarment: string; base: string; front: string; back: string | null; sleeves: string | null; otherParts: string | null; texts: { text: string; where: string }[] }
export const BlankDescriptionSchema: z.ZodType<{ blankDescription: string; unprintedParts: string }>
export function renderPrintMapping(d: Design): string
export function buildScalePrompt(target: { name: string; blankDescription: string; unprintedParts: string }, d: Design): string
export function designSystemPrompt(): string
export function designUserText(target: { name: string; blankDescription: string }): string
export function blankDescriptionSystemPrompt(): string
export const MAKE_BLANK_PROMPT: string
```

`buildScalePrompt` fills the frame in the spec's "Prompt recipe" verbatim. `renderPrintMapping`: sentences in order base → `Front view:` → `Back view:` → `Sleeves:` → other parts; when `back` is null → `Back view: continues the same base pattern with no additional graphic.`; texts rendered as `the text '<text>' on <where>` joined, followed by `spelled exactly the same`; no texts → no text sentence. `unprintedParts` empty → that line is omitted. `MAKE_BLANK_PROMPT` and the two system prompts follow the spec ("Targets", "Prompt recipe" §3) and the two reference scripts; all `strict`-schema fields required (nullable, not optional) because the Responses API runs `strict: true`.

- [ ] **Step 1:** Tests:

```ts
const target = { name: 'All-over Print Fleece Zip Hoodie', blankDescription: 'front view on the left with the zipper open showing the white sherpa lining, back view on the right.', unprintedParts: 'The ribbing, zipper and sherpa lining' }
const design: Design = { sourceGarment: 'varsity jacket', base: 'black with small yellow-green sparkles and orange clouds', front: 'an armored figure on a hill in front of a large orange sun', back: 'a large poster graphic centered on the back panel', sleeves: 'cream base with orange clouds', otherParts: null, texts: [{ text: 'STAR WARS DAY', where: 'the back' }, { text: '2026', where: 'the back' }] }

it('fills the frame with target, design and unprinted parts', () => {
  const p = buildScalePrompt(target, design)
  expect(p).toContain('IMAGE 2 is a blank All-over Print Fleece Zip Hoodie mockup on a white background: front view on the left')
  expect(p).toContain('Keep IMAGE 2 EXACTLY')
  expect(p).toContain('from IMAGE 1 (a varsity jacket mockup)')
  expect(p).toContain('IMAGE 1 is the source of the artwork ONLY')
  expect(p).toContain("the text 'STAR WARS DAY' on the back")
  expect(p).toContain('spelled exactly the same')
  expect(p).toContain('The ribbing, zipper and sherpa lining stay unprinted.')
  expect(p).toContain('Do not invent new graphics or text.')
})
it('does not invent a back graphic when the source shows no back', () => {
  const p = buildScalePrompt(target, { ...design, back: null, texts: [] })
  expect(p).toContain('Back view: continues the same base pattern with no additional graphic.')
  expect(p).not.toContain('spelled exactly')
})
it('drops the unprinted line when the target has none', () => {
  expect(buildScalePrompt({ ...target, unprintedParts: '' }, design)).not.toContain('stay unprinted')
})
it('escapes nothing but strips line breaks from model text so the frame stays one block per line', () => {
  expect(renderPrintMapping({ ...design, front: 'line one\nline two' })).not.toContain('\n')
})
it('DesignSchema rejects a design without sourceGarment', () => {
  expect(DesignSchema.safeParse({ ...design, sourceGarment: undefined }).success).toBe(false)
})
```

- [ ] **Step 2:** Run → fail. **Step 3:** Implement. **Step 4:** Run → pass. **Step 5:** Commit `feat(scale): prompt frame and design description schema`.

### Task 3: Vision client

**Files:** Create `src/lib/scale/vision.ts`, `tests/scale-vision.test.ts`

**Interfaces — Consumes:** `parseResponsesBody` from `@/lib/llm/kie-responses`. **Produces:**

```ts
export type Vision = { describe<T>(p: { model: string; system: string; text: string; images: string[]; schema: z.ZodType<T>; schemaName: string }): Promise<T> }
export function kieVision(apiKey: string, fetchImpl?: typeof fetch): Vision
```

`images` are data URLs. Body: `{ model, stream: false, instructions: system, reasoning: { effort: 'low' }, input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }], text: { format: { type: 'json_schema', name, strict: true, schema: z.toJSONSchema(schema) } } }` to `https://api.kie.ai/openai/v1/responses`. Non-JSON HTTP error → `Error('kie vision HTTP <status>: …')`; unparsable output → `Error('kie vision returned an unparsable <schemaName>: …')`.

- [ ] **Step 1:** Tests with a fake fetch: (a) request carries one `input_text` and two `input_image` parts in order and the json_schema format; returns the parsed object from an `output_text` body. (b) `{code:401,msg:'The API key is not authorized to use this model.'}` body → rejects with a message containing `401` and `not authorized`. (c) output text that is not valid for the schema → rejects with `unparsable`.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat(scale): Kie vision call with image input`.

### Task 4: Settings and dependencies

**Files:** Create `src/lib/scale/settings.ts`, `tests/scale-settings.integration.test.ts`

**Interfaces — Consumes:** `getCreativeSecrets`, `getCsSecrets`, `getCsSettings`, `kieClient`, `kieVision`, `maskApiKey`. **Produces:**

```ts
export type ScaleSettings = { imageModel: string; fallbackModel: string; allowFallback: boolean; visionModel: string | null; resolution: string }
export const DEFAULT_SCALE_SETTINGS: ScaleSettings // 'gpt-image-2-5-flare-image-to-image', 'seedream/4.5-edit', false, null, '2K'
export async function getScaleSettings(): Promise<ScaleSettings>
export async function saveScaleSettings(patch: Partial<ScaleSettings>): Promise<ScaleSettings> // slugs validated with isValidModelSlug; invalid → throws ScaleInputError
export async function scaleSettingsView(): Promise<ScaleSettings & { effectiveVisionModel: string; imageKeyMasked: string | null; imageKeySource: string | null; visionKeyMasked: string | null }>
export type ScaleDeps = { image: ImageClient | null; vision: Vision | null; settings: ScaleSettings; visionModel: string; fetchImpl: typeof fetch }
export type ImageClient = Pick<ReturnType<typeof kieClient>, 'schema' | 'uploadBase64' | 'createTask' | 'poll'>
export async function loadScaleDeps(): Promise<ScaleDeps>
export class ScaleInputError extends Error
export function explainKieError(err: unknown, key: 'Creative' | 'CS', slug: string): string
```

Stored as JSON in `AppSetting` key `scale.settings`. `visionModel` null → CS settings `model` read live. `explainKieError`: message matching `/not authorized/i` or starting with a 401 → `Key Kie (<key>) chưa được cấp quyền model <slug>`; otherwise the original message.

- [ ] **Step 1:** Tests: defaults when nothing saved; save + read back; invalid slug `'../x'` rejected; `effectiveVisionModel` follows CS settings until `visionModel` is set; `explainKieError(new Error('kie createTask 401: The API key is not authorized to use this model.'), 'Creative', 'gpt-x')` → `'Key Kie (Creative) chưa được cấp quyền model gpt-x'`; view never contains a full key.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat(scale): settings, key routing and Kie error wording`.

### Task 5: Storage and targets

**Files:** Modify `src/lib/creative/storage.ts` (extract `fetchImage(url, fetchImpl): Promise<{ bytes: Buffer; ext: string }>` used by `saveResult`; behaviour unchanged). Create `src/lib/scale/storage.ts`, `src/lib/scale/targets.ts`, `tests/scale-targets.integration.test.ts`

**Interfaces — Produces:**

```ts
// storage.ts
export function scaleRoot(): string // storageRoot()/scale
export async function writeScaleFile(kind: 'targets' | 'jobs', id: string, base: 'blank' | 'candidate' | 'src' | 'out', bytes: Buffer, ext: string): Promise<string> // returns file name, removes same-base files with other extensions
export async function readScaleFile(kind: 'targets' | 'jobs', id: string, name: string): Promise<{ bytes: Buffer; mime: string } | null>
export function resolveScaleFile(kind: string, id: string, name: string): string | null // whitelist ^(blank|candidate|src|out)\.(png|jpe?g|webp)$, id ^[a-z0-9_]+$/i
export async function deleteScaleFolder(kind: 'targets' | 'jobs', id: string): Promise<void>
export function toDataUrl(bytes: Buffer, mime: string): string

// targets.ts
export function targetView(t: ScaleTarget): ScaleTarget & { ready: boolean } // ready = active && blankFile && blankDescription.trim()
export async function listTargets(opts?: { readyOnly?: boolean }): Promise<ScaleTarget[]> // sortOrder, name
export async function createTarget(p: { name: string; sku: string }): Promise<ScaleTarget>
export async function updateTarget(id: string, p: Partial<Pick<ScaleTarget, 'name' | 'sku' | 'blankDescription' | 'unprintedParts' | 'active' | 'sortOrder'>>): Promise<ScaleTarget> // active:true without blank+description → ScaleInputError
export async function deleteTarget(id: string): Promise<void>
export async function setBlank(id: string, dataUrl: string): Promise<ScaleTarget>
export async function startCandidate(id: string, dataUrl: string, deps: ScaleDeps): Promise<ScaleTarget> // upload `scale-blank-<id>-<Date.now()>.<ext>`, createTask(imageModel, MAKE_BLANK_PROMPT), candidateStatus 'running'
export async function refreshCandidate(id: string, deps: ScaleDeps): Promise<ScaleTarget> // poll → download to candidate.<ext>, status 'ready' | 'failed' + candidateError
export async function acceptCandidate(id: string): Promise<ScaleTarget> // candidate file becomes blank, candidate fields cleared
export async function discardCandidate(id: string): Promise<ScaleTarget>
export async function suggestDescription(id: string, deps: ScaleDeps): Promise<{ blankDescription: string; unprintedParts: string }> // vision on the blank, not saved
export function imageInput(form: ModelForm, prompt: string, urls: string[], resolution: string): Record<string, unknown> // options: any enum containing '1:1' → '1:1'; option named 'resolution' containing the setting → it; rest via buildInput
```

- [ ] **Step 1:** Tests (temp `DESIGN_STORAGE_DIR`, fake `ScaleDeps`): create → not ready; `updateTarget(active:true)` without blank → throws `ScaleInputError`; `setBlank` with a PNG data URL writes `blank.png` and a second `setBlank` with JPEG removes it and writes `blank.jpg`; with description + active → `listTargets({readyOnly:true})` returns it; `startCandidate` → `createTask` called with a prompt containing `REMOVE ALL PRINTED ARTWORK`, one image URL and `aspect_ratio: '1:1'`; `refreshCandidate` on poll done writes the candidate and sets `ready`; `acceptCandidate` moves it to blank; poll failed → `candidateStatus 'failed'` with the message; `resolveScaleFile('jobs','..','out.png')` → null; `suggestDescription` passes the blank as a data URL to `vision.describe` with `schemaName 'scale_blank'`.
- [ ] **Step 2–5:** fail → implement → pass (also `npx vitest run tests/creative-jobs.integration.test.ts`) → commit `feat(scale): target products, blanks and blank generation`.

### Task 6: Job pipeline

**Files:** Create `src/lib/scale/jobs.ts`, `tests/scale-jobs.integration.test.ts`

**Interfaces — Produces:**

```ts
export function scaleJobView(j: ScaleJob, opts: { debug: boolean }): object // debug false → no prompt/designJson
export async function createScaleJob(p: { targetId: string; image: { dataUrl: string; name: string }; userId?: string }, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> // validates, saves src, status 'describing'; run !== false → void runPipeline(job.id, deps)
export async function runPipeline(jobId: string, deps: ScaleDeps): Promise<ScaleJob> // never throws; failure → status 'failed'
export async function refreshScaleJob(id: string, deps: ScaleDeps): Promise<ScaleJob>
export async function rerunScaleJob(id: string, userId: string | undefined, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> // new job, same src + target, fresh vision
export async function fallbackScaleJob(id: string, userId: string | undefined, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> // requires allowFallback, source job failed with designJson; new job model = fallbackModel, reuses designJson
export async function listScaleJobs(take?: number): Promise<ScaleJob[]>
export async function deleteScaleJob(id: string, user: { id: string; role: string }): Promise<void> // creator or SUPERADMIN, else ScaleInputError('Chỉ người tạo hoặc superadmin được xóa')
```

Pipeline: load job + target (must be ready) → upload src as `scale-<jobId>-src.<ext>` and blank as `scale-<jobId>-blank.<ext>` → if no `designJson`: `vision.describe({ model: deps.visionModel, images: [srcDataUrl], schema: DesignSchema, schemaName: 'scale_design', … })`, store `designJson` → `buildScalePrompt` → `image.schema(model)` → `imageInput(form, prompt, [srcUrl, blankUrl], resolution)` → `createTask` → `running`. Errors: vision step wrapped with `explainKieError(err,'CS',visionModel)`, image step with `explainKieError(err,'Creative',model)`; missing client → `Chưa có API key Kie cho bước <đọc ảnh|tạo ảnh>`. `refreshScaleJob`: `describing` older than 5 min → failed `Bị gián đoạn, bấm Tạo lại`; `running` → same rules as `refreshJob` in `src/lib/creative/jobs.ts` (pending `resultUrl` retried first, 30-min give-up, poll exception keeps running with `Poll lỗi: …`, download failure keeps `resultUrl`).

- [ ] **Step 1:** Tests (fake deps; `opts.run:false` then `await runPipeline`): happy path → `running`, uploads named `scale-<id>-src.png` and `scale-<id>-blank.png`, `createTask` got both URLs in order and a prompt containing `Keep IMAGE 2 EXACTLY`, vision got model `deps.visionModel`; then refresh with poll done → `done`, `out.png` on disk, cost `'12 credits'`. Target not ready → `ScaleInputError('Sản phẩm đích chưa sẵn sàng')` and no upload. Non-image data URL → `ScaleInputError`. Vision throws 401 → failed, error `Key Kie (CS) chưa được cấp quyền model gpt-6.1-sol`. `createTask` throws 401 → failed, error names `Creative` and the image slug, `designJson` kept. Poll `failed` → failed with Kie's message. `fallbackScaleJob` with `allowFallback:false` → `ScaleInputError`, no new row; with `true` → new job `model: 'seedream/4.5-edit'`, `parentJobId` set, vision not called again. `rerunScaleJob` → new job, vision called again. Job `describing` with `createdAt` 6 min ago → refresh marks failed `Bị gián đoạn, bấm Tạo lại`. `deleteScaleJob` by another non-superadmin → throws; by creator → row and folder gone. `scaleJobView(job,{debug:false})` has no `prompt`.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat(scale): two-step job pipeline with re-run and fallback`.

### Task 7: API routes

**Files (create):** under `src/app/api/tools/scale/`: `targets/route.ts` (GET list — `readyOnly` unless superadmin; POST create), `targets/[id]/route.ts` (PATCH, DELETE), `targets/[id]/blank/route.ts` (POST `{dataUrl}`), `targets/[id]/candidate/route.ts` (POST start `{dataUrl}`, GET refresh, PUT accept, DELETE discard), `targets/[id]/suggest/route.ts` (POST), `jobs/route.ts` (GET, POST), `jobs/[id]/route.ts` (GET refresh, DELETE), `jobs/[id]/rerun/route.ts` (POST), `jobs/[id]/fallback/route.ts` (POST), `file/[kind]/[id]/[name]/route.ts` (GET), `settings/route.ts` (GET view, POST save).

Pattern = the Creative routes. Every handler under `jobs/` and `targets/` starts with `requireApiAccess(req)`; every non-GET under `targets/` and settings POST also `requireSuperadmin(req)`. `ScaleInputError` → 400, other errors → 502. Job views use `debug: user.role === 'SUPERADMIN'`. The file route serves `targets` and `jobs` kinds through `resolveScaleFile`, `Cache-Control: private, max-age=300` (blanks can be replaced).

- [ ] **Step 1:** `npx tsc --noEmit` clean; `npx eslint --ext .ts,.tsx src/app/api/tools/scale src/lib/scale` clean.
- [ ] **Step 2:** Commit `feat(scale): API routes`.

### Task 8: Page

**Files (create):** `src/app/tools/scale/page.tsx`, `src/components/scale/{ScaleForm,ScaleJobCard,TargetManager,ScaleSettings,types}.tsx|ts`. Modify `src/components/creative/GenerateForm.tsx` only to export `shrinkImage` if it is not exported.

Behaviour per spec "Screen": form (one image, target grid of ready targets, **Tạo mockup**), history cards (source | result, target, status labels `Đang đọc thiết kế` / `Đang tạo ảnh` / `Xong` / `Lỗi`, creator, date `en-US`, cost, **Tải về**, **Tạo lại**, **Thử model dự phòng** only when the job failed, has a design and `allowFallback` is on; delete for creator/superadmin; superadmin sees a collapsible prompt). Polling every 3 s for `describing`/`running`, timers in a ref cleared on unmount. Superadmin tabs **Sản phẩm đích** (list all, edit fields, upload blank, Tạo phôi từ ảnh with candidate preview + Dùng làm phôi / Bỏ, Gợi ý mô tả, active switch) and **Cài đặt** (three slugs, resolution, fallback switch, masked key status, link to `/tools/creative`).

- [ ] **Step 1:** Build the page; `npx tsc --noEmit` + eslint on the new files clean.
- [ ] **Step 2:** Start the worktree dev server (launch config on a free port), log in, verify in the browser: page renders, target grid shows only ready targets, superadmin tabs work, upload FEHOVN blank + description, console clean.
- [ ] **Step 3:** Commit `feat(scale): Scale sản phẩm page`.

### Task 9: Live run, docs, review

- [ ] **Step 1:** Live: `source_varsity.jpg` → FEHOVN through the page. Compare with `fleece-zip-hoodie-FEHOVN_v2_blankref.png`. If the image key is refused, record the exact message; feature is "built, not verified live".
- [ ] **Step 2:** Live (needs the same key): one "Tạo phôi từ ảnh" trial; if the garment drifts or the background is not white, switch to the two-pass variant described in the spec.
- [ ] **Step 3:** `npx vitest run` (full), `npx tsc --noEmit`.
- [ ] **Step 4:** Add a "Scale sản phẩm" section to `PLAN.md` and `NOTES.md` (what exists, key routing, rollout steps from the spec). Commit `docs: scale product tool`.
- [ ] **Step 5:** Fresh reviewer over the whole branch diff; fix findings; report to the owner with what was and was not verified.
