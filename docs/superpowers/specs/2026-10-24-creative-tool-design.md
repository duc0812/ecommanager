# Creative Tool — design (2026-10-24)

## Intent

A page under **Tools** where the owner (and seller Nghĩa) can try image models from two
aggregators, **Kie** (`api.kie.ai`) and **Replicate**, with one form: prompt, reference
images, model. The owner is specifically testing **Chinese models** (Qwen, Seedream /
ByteDance, Kling, Wan / Alibaba, Hunyuan / Tencent, MiniMax, Vidu, Zhipu); the UI must put
those first and make side‑by‑side comparison of results easy.

"Simple for now": no cron, no credits budget, no video. Images only.

## Goals

- Pick provider → pick model (China models first) → prompt → up to N reference images → Generate.
- Results appear as jobs in a grid under the form, with status, images, model, credits/cost,
  prompt (copyable), and a re‑run button that refills the form.
- Model list for Kie comes from the live catalog, not from memory. Replicate gets a curated
  China list + free‑text `owner/name`.
- Result images are persisted on the server (Kie URLs die after 14 days).
- Access controlled by a new feature permission `tools_creative`.

## Non‑goals / anti‑goals

- No video, audio or chat models (filtered out of the catalog).
- No background scheduler: polling happens only while the page is open, plus a lazy
  refresh of unfinished jobs when the page loads.
- Never hardcode Kie model slugs in code; the catalog is the truth.
- Keys never leave the server; GET returns masked values only.

## Constraints (from CLAUDE.md / security model)

- New routes need rules in `API_ACCESS_RULES`; key writes call `requireSuperadmin`.
- Prisma schema change → migration folder (check `prisma/migrations` actually got it, the
  CLI is silent on this PC) + `SCHEMA_VERSION` bump.
- Tests run on `test.db` only.
- Outbound fetches of user‑supplied URLs go through `assertSafeExternalUrl`.

## Decisions

### Keys
- Kie: reuse `cs.kieApiKey` (already stored in `AppSetting` by the CS agent; falls back to
  `KIE_API_KEY` env). Read through `getCsSecrets()`.
- Replicate: new setting `creative.replicateApiToken`, entered on the Creative page (card
  visible to superadmin only), masked on read, saved via POST with `requireSuperadmin`.

### Data
New model `CreativeJob`:

| field | type | note |
|---|---|---|
| id | cuid | |
| provider | `kie` \| `replicate` | |
| model | string | slug as the provider names it |
| prompt | string | |
| inputJson | string | the exact `input` object sent |
| refImages | string | JSON array of stored reference file names |
| status | `queued` \| `running` \| `done` \| `failed` | |
| providerTaskId | string? | Kie taskId / Replicate prediction id |
| resultFiles | string | JSON array of stored result file names |
| error | string? | |
| cost | string? | Kie `creditsConsumed` or Replicate `metrics.predict_time` text |
| durationMs | int? | |
| createdBy | string? | AppUser id |
| createdAt / completedAt | DateTime | |

Files live under `storage/creative/<jobId>/` (`ref-N.ext`, `out-N.ext`) and are served by
`GET /api/tools/creative/file/<jobId>/<name>` (path‑segment whitelist, no traversal).

### Model catalog
- Kie: `GET /api/v1/models`, cached in memory 10 min, filtered to taskType containing
  "Text to Image", "Image to Image" or "Image Edit". Each entry gets `china: true` when
  provider/slug matches the list above. UI shows a "China" group first, then "Other".
  Refresh button bypasses the cache.
- Replicate: curated list in `src/lib/creative/replicate-models.ts` (qwen/qwen-image,
  qwen/qwen-image-edit-plus, bytedance/seedream-4, bytedance/seededit-3.0,
  tencent/hunyuan-image-3, wan-video/wan-2.5-t2i… — verified against replicate.com at
  build time, trimmed if a slug 404s) plus free text. Replicate exposes
  `GET /v1/models/{owner}/{name}` with `latest_version.openapi_schema`, used for input mapping.

### Input mapping (builder's call, generic rather than per‑model)
Both providers publish an OpenAPI schema per model. A shared mapper picks:
- prompt field: first string property named `prompt` (else first required string).
- image field(s): properties whose name contains `image` and whose type is string (URI) or
  array of strings; the first such property receives the reference URLs (array if the
  schema allows, else the first image only, and the UI says so).
- aspect ratio: property named `aspect_ratio` or `image_size`/`size` with an enum; the UI
  offers the enum values when present.
If no image field exists and the user attached images, the API returns 400 with a clear
message instead of silently dropping them.

### Provider flow
- **Kie**: upload each ref image via `https://kieai.redpandaai.co/api/file-base64-upload`
  (≤10 MB) → `createTask` → store `taskId` → `recordInfo` polling from the job status
  route (state machine waiting/queuing/generating/success/fail). On success download
  `response.resultUrls[]` into storage.
- **Replicate**: ref images via `POST https://api.replicate.com/v1/files` (multipart) →
  `POST /v1/models/{owner}/{name}/predictions` (no `Prefer: wait`, keep it async) → poll
  `GET /v1/predictions/{id}`; `output` may be a string or array of URLs.
- Status route `GET /api/tools/creative/jobs/[id]` does one provider poll per call when the
  job is not terminal, then returns the job. The page polls every 3 s per active job.

### Routes and access
| route | methods | access |
|---|---|---|
| `/api/tools/creative/models` | GET | `tools_creative` |
| `/api/tools/creative/jobs` | GET (list, filters), POST (create) | `tools_creative` |
| `/api/tools/creative/jobs/[id]` | GET, DELETE | `tools_creative` |
| `/api/tools/creative/file/[jobId]/[name]` | GET | `tools_creative` |
| `/api/tools/creative/settings` | GET | `tools_creative` (masked) |
| `/api/tools/creative/settings` | POST | SUPERADMIN + `requireSuperadmin` |

### Permission
- `tools_creative` ("Creative") added to `FeaturePermission`, labels, Tools group, ADMIN
  defaults, path map `/tools/creative`, and the ordered list.
- Seller **Nghĩa** keeps role SELLER and gets `tools_creative` ticked on his user in
  `/setup/users` on prod after deploy (per‑user override in `AppUser.permissions`). He
  must sign in again if his session payload caches permissions.

### UI
Page `src/app/tools/creative/page.tsx`, `'use client'`, Sidebar + `RoleGate` like
`/tools/resources`. Layout: form card (provider toggle, model select grouped China/Other,
prompt textarea, drop zone with thumbnails, aspect ratio select when the model has one,
Generate button with the model's `pricingDesc`), then a filter bar (provider, model, status)
and a responsive grid of job cards. Job card: result thumbnails (click → open file), model
chip with China flag badge, status pill, cost, elapsed, prompt (truncated, copy button),
"Dùng lại" (refill form), delete. User‑facing text in Vietnamese.

## Left to the builder
- Exact China‑provider matching list and how `pricingDesc` is shown.
- Storage limits (suggest 10 MB per ref image, max 4 images).
- Test coverage: unit tests for the schema mapper and Kie/Replicate response parsing with
  fake `fetch`; integration test for job create → poll → done on `test.db`.
