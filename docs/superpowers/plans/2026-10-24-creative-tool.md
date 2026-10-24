# Creative Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/tools/creative` page that generates images on Kie or Replicate from prompt + reference images + model, keeps a job history with stored result files, and is gated by a new `tools_creative` permission.

**Architecture:** One generic OpenAPI "form mapper" turns any model schema (Kie or Replicate) into `{promptField, imageField, options[]}`; the UI renders from that, the job service builds the provider `input` from it. Provider clients are thin fetch wrappers with pure parsers (unit-tested with fake fetch). A `CreativeJob` row + `storage/creative/<jobId>/` folder hold history; the job status route performs one provider poll per call.

**Tech Stack:** Next.js app router (`'use client'` pages), Prisma/SQLite, vitest, Tailwind tokens, Material Symbols.

**Spec:** `docs/superpowers/specs/2026-10-24-creative-tool-design.md`

## Global Constraints

- Every new `/api/*` prefix gets a rule in `API_ACCESS_RULES` (`src/lib/api-access.ts`); secret writes also call `requireSuperadmin`.
- Schema change → migration folder must exist in `prisma/migrations` (CLI may create nothing silently; build from `prisma migrate diff` if so), `npx prisma generate`, bump `SCHEMA_VERSION` in `src/lib/db.ts` (`'v74'` → `'v75'`).
- Tests only on `test.db`; integration tests create their own fixtures and inject fake `fetch`.
- Never hardcode Kie model slugs; Kie list comes from the catalog. Replicate curated list = `qwen/qwen-image`, `qwen/qwen-image-edit`, `qwen/qwen-image-edit-plus`, `bytedance/seedream-4`, `bytedance/seedream-4.5`, `tencent/hunyuan-image-3`, `prunaai/wan-2.2-image`, `minimax/image-01`.
- China provider match (case-insensitive on provider name or slug): `qwen`, `bytedance`, `seedream`, `wan`, `hunyuan`, `tencent`, `kling`, `minimax`, `hailuo`, `vidu`, `zhipu`, `z-image`, `glm`.
- Kie image task types: `Text to Image`, `Image to Image`, `Image Editing`.
- Limits: max 4 reference images, 10 MB each, PNG/JPG/WEBP only.
- Result URLs are downloaded into `storage/creative/<jobId>/out-N.<ext>` right after success.
- User-facing text in Vietnamese; code/comments English.

## Review Focus

- A model whose schema has a required enum the form did not set (e.g. seedream `quality`) → the request still succeeds because the mapper fills `default ?? enum[0]`. Test in Task 2.
- Reference images attached to a text-only model → 400 "Model này không nhận ảnh tham chiếu", not a silent drop. Test in Task 5.
- Kie returns HTTP 200 with body `code: 402/429` → job fails with the `msg`, never left "running". Test in Task 3.
- Replicate `output` as a single string instead of an array → one result file stored. Test in Task 4.
- Status route called for a job whose stored result files were deleted on disk → job still returns, image 404s, no crash. Test in Task 5.

---

### Task 1: Permission, nav, access rules, schema

**Files:**
- Modify: `src/lib/roles.ts` (FeaturePermission union, FEATURE_LABELS, Tools group, ADMIN defaults, path map, ordered list)
- Modify: `src/components/Sidebar.tsx:53` (add `{ type: 'child', href: '/tools/creative', icon: 'auto_awesome', label: 'Creative' }` after Resources)
- Modify: `src/lib/api-access.ts` (rules below)
- Modify: `prisma/schema.prisma` (model `CreativeJob`), new migration `creative_job`, `src/lib/db.ts` SCHEMA_VERSION `'v75'`
- Test: `src/lib/api-access.test.ts` (append cases)

**Interfaces:**
- Produces: permission `tools_creative`; rules `/api/tools/creative/settings` WRITE → `'SUPERADMIN'`, `/api/tools/creative` → `['tools_creative']`; Prisma model `CreativeJob { id, provider, model, prompt, inputJson, refImages @default("[]"), status @default("queued"), providerTaskId?, resultFiles @default("[]"), error?, cost?, durationMs?, createdBy?, createdAt, completedAt? }` with `@@index([createdAt])`.

- [ ] Step 1: Append to `src/lib/api-access.test.ts`: ADMIN with `['tools_creative']` can GET `/api/tools/creative/jobs` and POST `/api/tools/creative/jobs`; ADMIN cannot POST `/api/tools/creative/settings`; ADMIN without the permission cannot GET `/api/tools/creative/models`. Run → FAIL.
- [ ] Step 2: Edit roles, Sidebar, api-access (order: the settings WRITE rule before the prefix rule).
- [ ] Step 3: Add the Prisma model, run `npx prisma migrate dev --name creative_job`, verify `ls prisma/migrations | tail -1` shows it (else `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` into a new folder), `npx prisma generate`, bump SCHEMA_VERSION.
- [ ] Step 4: `npx vitest run src/lib/api-access.test.ts` → PASS. Commit `feat(creative): permission, nav and CreativeJob schema`.

### Task 2: Schema form mapper

**Files:**
- Create: `src/lib/creative/schema-map.ts`
- Test: `tests/creative-schema-map.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelOption = { name: string; values: string[]; default?: string; required: boolean }
  export type ModelForm = { promptField: string | null; imageField: string | null; imageIsArray: boolean; options: ModelOption[] }
  export function formFromInputSchema(input: any, root?: any): ModelForm   // input = JSON-schema object of the model input; root = document for $ref resolution
  export function buildInput(form: ModelForm, p: { prompt: string; imageUrls: string[]; options: Record<string, string> }): Record<string, unknown>  // throws Error('NO_IMAGE_FIELD') when imageUrls given but imageField null
  ```
- Rules: `$ref` resolved against `root` with URL-decoded segments; `allOf` of one `$ref` flattened; prompt = property named `prompt` else first required string; image = first property whose name contains `image` or `input_url` with type string (`format: uri` or not) or array of strings; options = every property with `enum` (string values), excluding the prompt/image field; `buildInput` sets `prompt`, image (array or first url), every option the caller passed, and for required options not passed `default ?? values[0]`.

- [ ] Step 1: Tests: (a) Kie seedream/4.5-edit-like schema → `promptField 'prompt'`, `imageField 'image_urls'`, `imageIsArray true`, options include `aspect_ratio` (required) and `quality` (required); `buildInput` with no options yields `aspect_ratio: '1:1'` and `quality: 'basic'`. (b) Kie wan-like schema with `input_urls` optional → imageField `'input_urls'`. (c) Replicate-style schema with `allOf: [{ $ref: '#/components/schemas/aspect_ratio' }]` and `image: { type: 'string', format: 'uri' }` → option values from the component, `imageIsArray false`, `buildInput` with two urls sets `image` to the first only. (d) text-only schema + images → throws `NO_IMAGE_FIELD`. Run → FAIL.
- [ ] Step 2: Implement. Step 3: `npx vitest run tests/creative-schema-map.test.ts` → PASS. Commit `feat(creative): generic model form mapper`.

### Task 3: Kie client

**Files:**
- Create: `src/lib/creative/kie.ts`
- Test: `tests/creative-kie.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CatalogModel = { provider: 'kie' | 'replicate'; slug: string; title: string; vendor: string; taskTypes: string[]; pricing: string | null; china: boolean }
  export function isChinaModel(vendor: string, slug: string): boolean
  export function filterImageModels(models: any[]): CatalogModel[]          // Kie catalog rows → image models, china first then by vendor/slug
  export function kieClient(apiKey: string, fetchImpl?: typeof fetch): {
    catalog(force?: boolean): Promise<CatalogModel[]>                     // memoised 10 min (module-level cache keyed by apiKey)
    schema(slug: string): Promise<{ input: any; root: any } | null>        // null when openapi null
    uploadBase64(dataUrl: string, fileName: string): Promise<string>       // returns downloadUrl
    createTask(model: string, input: Record<string, unknown>): Promise<string>   // taskId
    poll(taskId: string): Promise<{ state: 'running' } | { state: 'done'; urls: string[]; credits: number | null; costTime: number | null } | { state: 'failed'; error: string }>
  }
  export function parseKieEnvelope(body: string, what: string): any       // throws Error(`kie ${what} ${code}: ${msg}`) when code !== 200
  ```

- [ ] Step 1: Tests with fake fetch: catalog filter keeps only image task types and marks `qwen/text-to-image` china and `google/imagen4` not; `schema()` returns the `input` property schema from `paths['/api/v1/jobs/createTask'].post.requestBody` (through `$ref`); `createTask` posts `{model,input}` with the bearer header and returns taskId; `poll` maps `waiting/queuing/generating` → running, `success` → urls from `response.resultUrls` (fallback `JSON.parse(resultJson)`), `fail` → failMsg; HTTP 200 with `code: 402` → throws with msg. Run → FAIL.
- [ ] Step 2: Implement (`https://api.kie.ai`, upload at `https://kieai.redpandaai.co/api/file-base64-upload` with `uploadPath: 'images/creative'`). Step 3: tests PASS. Commit `feat(creative): kie image client`.

### Task 4: Replicate client

**Files:**
- Create: `src/lib/creative/replicate.ts`
- Test: `tests/creative-replicate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REPLICATE_MODELS: CatalogModel[]                               // curated list, china true
  export function replicateClient(token: string, fetchImpl?: typeof fetch): {
    schema(slug: string): Promise<{ input: any; root: any } | null>          // GET /v1/models/{slug} → latest_version.openapi_schema.components.schemas.Input
    uploadFile(bytes: Buffer, fileName: string, mime: string): Promise<string>  // POST /v1/files multipart field `content` → urls.get
    createPrediction(slug: string, input: Record<string, unknown>): Promise<string>  // POST /v1/models/{slug}/predictions → id
    poll(id: string): Promise<same union as kie.poll>                         // succeeded → output string|string[] → urls; failed/canceled → error; cost = metrics.predict_time
  }
  ```

- [ ] Step 1: Tests with fake fetch covering schema extraction, string vs array `output`, failed with `error`, and non-2xx HTTP → throws `replicate HTTP <status>`. Run → FAIL.
- [ ] Step 2: Implement with `Authorization: Bearer <token>`. Step 3: PASS. Commit `feat(creative): replicate client`.

### Task 5: Job service and storage

**Files:**
- Create: `src/lib/creative/jobs.ts`, `src/lib/creative/storage.ts`, `src/lib/creative/settings.ts`
- Test: `tests/creative-jobs.integration.test.ts`

**Interfaces:**
- `settings.ts`: `getCreativeSecrets(): Promise<{ kieApiKey: string | null; replicateToken: string | null }>` (kie from `getCsSecrets().kieApiKey`, replicate from AppSetting `creative.replicateApiToken` or env `REPLICATE_API_TOKEN`); `saveReplicateToken(token: string)`; `creativeSettingsView()` → `{ hasKie: boolean; kieMasked: string | null; hasReplicate: boolean; replicateMasked: string | null }` using `maskApiKey` from `@/lib/tracking/parcelpanel-config`.
- `storage.ts`: `creativeRoot()` = `path.join(storageRoot(), 'creative')`; `saveRef(jobId, index, dataUrl)` → file name `ref-N.ext`; `saveResult(jobId, index, url, fetchImpl)` → downloads (through `assertSafeExternalUrl`) to `out-N.ext` (ext from content-type, default png); `resolveFile(jobId, name)` → absolute path or null (name must match `/^(ref|out)-\d+\.(png|jpe?g|webp)$/`, jobId cuid chars only).
- `jobs.ts`:
  ```ts
  export type Providers = { kie?: ReturnType<typeof kieClient>; replicate?: ReturnType<typeof replicateClient> }
  export async function createJob(p: { provider: 'kie'|'replicate'; model: string; prompt: string; images: { dataUrl: string; name: string }[]; options: Record<string,string>; userId?: string }, providers: Providers, fetchImpl?: typeof fetch): Promise<CreativeJob>
  export async function refreshJob(id: string, providers: Providers, fetchImpl?: typeof fetch): Promise<CreativeJob>   // one poll when status is queued/running; on done downloads results, sets cost/durationMs/completedAt
  export async function listJobs(f: { provider?: string; model?: string; status?: string; take?: number }): Promise<CreativeJob[]>
  export async function deleteJob(id: string): Promise<void>   // row + folder
  export function jobView(j: CreativeJob): { ...j, refImages: string[], resultFiles: string[], input: any }
  ```
  `createJob` validation errors throw `CreativeInputError(message)` (400 in the route): empty prompt, >4 images, >10 MB, bad mime, `NO_IMAGE_FIELD` → `'Model này không nhận ảnh tham chiếu'`, missing provider key → `'Chưa có API key <provider>'`.

- [ ] Step 1: Integration test with fake fetch + fake providers: create kie job with one ref image → row status `running`, `ref-0.png` on disk, provider input has `image_urls: [uploadedUrl]` and `aspect_ratio` default; `refreshJob` while provider says running → unchanged; provider done with two urls → status `done`, `out-0.png`/`out-1.png` exist, `cost` set; provider failed → status `failed` + error; text-only model + image → `CreativeInputError`; deleting the out files then `refreshJob` → still returns the job. Use `DESIGN_STORAGE_DIR` pointed at a temp dir. Run → FAIL.
- [ ] Step 2: Implement. Step 3: PASS. Commit `feat(creative): job service with stored results`.

### Task 6: API routes

**Files:**
- Create: `src/app/api/tools/creative/models/route.ts` (GET `?provider=kie|replicate&refresh=1` → `{ models: CatalogModel[] }`; GET with `&model=<slug>` → `{ form: ModelForm, pricing }`)
- Create: `src/app/api/tools/creative/jobs/route.ts` (GET list with filters → `{ jobs }`; POST JSON `{ provider, model, prompt, images: [{dataUrl,name}], options }` → `{ job }`, 400 on `CreativeInputError`)
- Create: `src/app/api/tools/creative/jobs/[id]/route.ts` (GET → refreshJob → `{ job }`; DELETE → `{ ok: true }`)
- Create: `src/app/api/tools/creative/file/[jobId]/[name]/route.ts` (serve from `resolveFile`, same headers as the design-studio guide route)
- Create: `src/app/api/tools/creative/settings/route.ts` (GET → `creativeSettingsView()`; POST `{ replicateToken }` with `requireSuperadmin`)
- All routes `export const dynamic = 'force-dynamic'`; POST jobs uses `getAuthUser(req)?.id` as `createdBy`; body limit: images are data URLs, so set `export const maxDuration = 60` and rely on Next body size default (check `next.config` for `serverActions.bodySizeLimit`; API routes have no limit).

- [ ] Step 1: `npx tsc --noEmit -p .` clean. Step 2: smoke with the dev server (`curl` GET models as superadmin cookie is awkward — verify through the page in Task 7 instead). Commit `feat(creative): api routes`.

### Task 7: Page

**Files:**
- Create: `src/app/tools/creative/page.tsx`
- Create: `src/components/creative/JobCard.tsx`, `src/components/creative/GenerateForm.tsx`

- [ ] Step 1: Build per spec UI section: provider toggle, model select (optgroup "Model Trung Quốc" first, "Khác" after; Replicate adds free-text `owner/name` input), prompt textarea, drop zone (FileReader → data URLs, thumbnails, remove), options selects from `/models?model=`, pricing text under the button, "Tạo ảnh" button. Polling: every 3 s per job whose status is queued/running. Filter bar: provider, model, status. Job card: thumbnails linking to the file route, badge "CN" when china, status pill (`Đang chạy`/`Xong`/`Lỗi`), cost, elapsed, prompt with copy, "Dùng lại", delete (confirm). Superadmin-only card for the Replicate token with masked state.
- [ ] Step 2: `preview_start` the dev server, open `/tools/creative`, generate one image on a cheap Kie China model (`z-image` or `qwen/text-to-image`), confirm the card goes running → done with a stored file; screenshot. Commit `feat(creative): /tools/creative page`.

### Task 8: Docs, deploy notes

- [ ] Update `PLAN.md`/`NOTES.md` (Creative tool shipped, keys, Nghĩa permission step). Commit. Report the prod steps: deploy, enter Replicate token on the page, tick `tools_creative` on Nghĩa in `/setup/users`, Nghĩa signs in again.
