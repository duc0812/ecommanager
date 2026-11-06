# Scale Product Tool — design (2026-11-06)

## Intent

Staff take a product image that already sells (any garment, usually a competitor or our own
mockup) and "scale" its design onto another product we can fulfil: upload one image, pick a
target product, get a mockup of the same design on the target. Example from the owner: a
fleece‑lined jacket image → 3D hoodie, or the other way round.

The owner has done this by hand a few times (project `D:\LZ POD ECOM\ads\mockups`,
10/27/2026: Star Wars varsity jacket → Merchize fleece zip hoodie FEHOVN). He now wants it as a
tool so staff can do it without writing prompts. **The prompt recipe from that run is the
heart of this tool**; the rest is plumbing that already exists in the Creative tool.

## What the owner decided

- Input: one product image + one target product chosen from a backend list. No prompt box.
- Backend holds a **blank mockup** per target product and sends source image + blank to Kie.
- The prompt is assembled from three parts (see "Prompt recipe"); parts 1–2 are fixed in the
  backend, part 3 is written automatically by a vision model from the uploaded image.
- Generation goes through **Kie** (the earlier run used 9Router on the owner's PC, which the
  server cannot reach).
- First target list = jackets and all‑over‑print ("3D") tops, 14 products (see "Targets").
- Result: one square image, shown beside the source, shared history, per‑user permission.
- Out of scope for now: print files for the factory, pushing images to Shopify, batch runs.

Everything else below is the designer's call unless marked otherwise.

## Goals

- A staff member with no prompt skills gets a usable listing mockup in one click.
- Output follows the **blank's** composition (garment shape, folds, camera, white background);
  only the fabric print comes from the source image. Texts on the garment keep their spelling.
- Superadmin can add/edit target products and their blanks on the page, without a deploy.
- A refused or failed generation says so plainly and never looks like a success.

## Non‑goals / anti‑goals

- No free prompt editing for staff (that is the Creative tool).
- No print‑ready AOP files, no Shopify upload, no batch (many sources or many targets at once).
- No background scheduler; progress is driven by the open page (same as Creative).
- Never send the Merchize sample photo (which carries its own print) as the blank. The earlier
  runs showed the model copies whatever print the reference has; blanks are plain grey.
- Never reuse an upload file name between jobs. Rosterpress runs showed designs getting
  swapped when two uploads shared a name.
- The fallback model is never used silently (owner's standing rule: GPT Image first, ask
  before seedream).

## Prompt recipe

Two reference images, in this order: **IMAGE 1 = source product image**, **IMAGE 2 = blank
mockup of the target**. Prompt = frame with three slots filled in.

```
IMAGE 2 is a blank {targetName} mockup on a white background: {blankDescription}
Keep IMAGE 2 EXACTLY: same composition, same garment shapes, folds, construction details,
camera angle and pure white background. Only replace the plain grey outer fabric with the
all-over printed design from IMAGE 1 (a {sourceGarment} mockup).
IMAGE 1 is the source of the artwork ONLY; ignore its garment shape, collar, trims, closures
and background scene.
Print mapping: {printMapping}
{unprintedParts} stay unprinted.
Do not invent new graphics or text. Realistic printed fabric with natural folds and soft
studio shadow, sharp high-resolution product photography, square 1:1.
```

1. **Frame** — constant in code. Wording comes from the run that worked
   (`D:\LZ POD ECOM\ads\mockups\star-wars-fleece-zip-hoodie\convert.py`, read it before
   changing a word).
2. **Blank part** — `targetName`, `blankDescription` (construction: closures, lining, pockets,
   ribbing, how front/back are laid out in the blank) and `unprintedParts` (e.g. "The
   ribbing, zipper and sherpa lining"). Stored per target, written once.
3. **Design part** — `sourceGarment` and `printMapping`, produced per job by a vision model
   that looks at the source image **and is given the target's blank description**, so it can
   say where each piece of art goes on the new cut. It returns structured JSON:
   `sourceGarment`, `base` (ground colour/pattern of body, hood, back), `front`, `back`,
   `sleeves`, `otherParts`, `texts[]` (every visible word, exact spelling and where it sits).
   The server renders that into the `Print mapping:` paragraph, with each text quoted and the
   phrase "spelled exactly the same". If the source shows no back view, `back` continues the
   base pattern and no back graphic is invented.

The vision step's own system prompt is the builder's to write; model it on the hand‑written
mapping in `convert.py` (area by area, colours named, texts quoted, trims of the source
garment explicitly dropped).

The full assembled prompt and the vision JSON are stored on the job (superadmin can view them
on the job card for debugging; staff do not see them).

## Models (Kie)

Stored as settings, editable by superadmin, seeded with:

| Setting | Default | Notes |
|---|---|---|
| image model | `gpt-image-2-5-flare-image-to-image` | image field `input_urls`, `aspect_ratio 1:1`, `resolution 2K` |
| fallback image model | `seedream/4.5-edit` | image field `image_urls` |
| allow fallback | **off** | owner turns it on |
| vision model | same model the CS agent uses (`cs` settings `model`) | via `src/lib/llm/kie-responses.ts` endpoint |

- Build the task input through the existing schema mapper (`src/lib/creative/schema-map.ts`
  `formFromInputSchema` / `buildInput`) so field names and required enums come from the live
  schema, not from this table.
- **Unverified:** whether Kie's `/openai/v1/responses` accepts image input (`input_image`).
  First build step is one live call to find out. If it does not, use the Kie Claude endpoint
  (`src/lib/llm/anthropic.ts`, image by URL). If neither reads images with the configured key,
  stop and report to the owner; do not ship a version without part 3.
- **Two keys, two clients** (designer's call). Kie authorises models per key, and the CS key
  and the Creative key can be different keys:
  - image steps (scale job, blank generation) use `getCreativeSecrets().kieApiKey` — the key
    pasted on the Creative page, falling back to the CS key as that function already does;
  - the vision step uses the CS agent's own key and model, read **live** from CS settings on
    every job (so it follows later CS model changes), unless `scale.visionModel` is set.
  "Cài đặt" shows the masked status of both keys and says which step uses which.
- **Known risk:** the `.env` key was refused for every image model on 10/24/2026. A 401 "not
  authorized to use this model" must surface as "Key Kie (<Creative|CS>) chưa được cấp quyền
  model <slug>", naming the key and the slug, never as a generic failure.
- If the vision probe forces the Claude endpoint, the Claude slug is a setting
  (`scale.visionModel`); the builder proposes one the key accepts and reports it.

## Job flow

1. `POST /api/tools/scale/jobs` `{ targetId, image: { dataUrl, name } }` → validate, create
   `ScaleJob` (`describing`), save the source file, return the job immediately.
2. In‑process, not awaited (PM2 runs one long‑lived `next` process): upload source and blank to
   Kie with **unique names** (`scale-<jobId>-src.<ext>`, `scale-<jobId>-blank.png`) → vision
   call → assemble prompt → `createTask` → status `running`. Any error → `failed` with the
   message.
3. Page polls `GET /api/tools/scale/jobs/<id>` every 3 s; `running` jobs are refreshed against
   Kie exactly like `refreshJob` in `src/lib/creative/jobs.ts` (transient poll errors keep the
   job running, 30‑minute give‑up, result downloaded to disk because Kie URLs expire).
4. A job still `describing` after 5 minutes (process restarted mid‑step) is marked `failed`
   "Bị gián đoạn, bấm Tạo lại".

**Tạo lại** = new job, same source file and target, fresh vision step.

**Refusal / failure of the image step:** job is `failed` and shows Kie's own message. If
`allow fallback` is on, the card shows **Thử model dự phòng**: a new job on the fallback model
reusing the stored design description (no second vision call). With the switch off the card
says the owner has not enabled a fallback model. No attempt is made to classify "refusal" vs
other failures; the raw message is shown either way.

## Targets

A target = name, Merchize SKU, blank image, blank description, unprinted parts, active flag,
sort order. Staff can pick a target only when it is active and has a blank and description.

Superadmin screen (tab on the same page):

- **Add / edit** a target; upload a ready blank image directly.
- **Tạo phôi từ ảnh**: upload a good‑looking photo of that product type → one Kie image call
  with a fixed "make it blank" prompt → preview → superadmin accepts or regenerates. Accepted
  image becomes the blank. Prompt generalised from
  `D:\LZ POD ECOM\ads\mockups\fleece-zip-hoodie-blank\blank.py`: keep the exact garment cut,
  folds, composition and construction; remove every print, text and logo; whole outer fabric
  one plain medium heather grey; smooth matte polyester (no bouclé/speckled texture — the v1
  blank had it and it carried over into results); pure white seamless background.
  **Untested as one call:** `blank.py` kept the original scene and the white background was
  made afterwards with a local background‑removal tool the server does not have. Try the
  one‑call prompt live on one product during the build. If the garment drifts or the
  background is not clean white, make it two Kie passes (remove prints keeping the scene,
  then "same garment, pixel‑faithful, on pure white"). Uploading a ready blank always works
  as the escape hatch. Generation is asynchronous like a job; the pending candidate image is
  stored beside the target (`candidate.<ext>` + task id/status on the row) until accepted or
  discarded.
- **Gợi ý mô tả**: vision model drafts `blankDescription` + `unprintedParts` from the blank;
  superadmin edits and saves.

Seeded rows (inactive, no blank yet):

| SKU | Product |
|---|---|
| FEHOVN | All-over Print Fleece Zip Hoodie |
| FLHDVN | All over Print Fleece Hoodie |
| FEBOVN | All-over Print Fleece Bomber Jacket |
| BOJAVN | All-over Print Bomber Jacket |
| BBJAVN | All-over Print Baseball Jacket |
| HBBJVN | All-over Print Hooded Baseball Jacket |
| QUBOVN | All-over Print Quilt Bomber Jacket |
| HCLKVN | All-over Print Hooded Cloak Coat |
| MWHDVN | All-over Print Hoodie (Midweight) |
| MWZHVN | All-over Print Zip Hoodie (Midweight) |
| MWSSVN | All-over Print Sweatshirt (Midweight) |
| T5HAVN | All-over Print Unisex T-shirt |
| KNSWVN | All-over Print Knitted Sweater |
| KNCAVN | All-over Print Knitted Cardigan |

Blanks are data, not code: they live in the storage directory, not in git. After deploy,
FEHOVN gets the existing blank
(`D:\LZ POD ECOM\ads\mockups\fleece-zip-hoodie-blank\fleece-zip-hoodie-blank_grey_v2_white.png`)
uploaded through the page; the other 13 are made with **Tạo phôi từ ảnh** and each is approved
by the owner before it is switched on. That work is a rollout step, not part of the build.

## Screen (`/tools/scale`, "Scale sản phẩm" under Tools)

Same page skeleton as `/tools/creative` (Sidebar, RoleGate, card patterns from CLAUDE.md).

- **Form:** drop zone for one image (client‑side shrink to ≤ 2048 px, reuse `shrinkImage`
  from the Creative form) · target picker as a grid of cards (blank thumbnail + name) ·
  **Tạo mockup** button.
- **History:** newest first, shared by everyone with the permission. Each card: source image
  and result side by side, target name, status (`Đang đọc thiết kế` / `Đang tạo ảnh` / done /
  failed + message), creator, date in `MM/DD/YYYY`, credits, buttons **Tải về**, **Tạo lại**,
  and (when allowed) **Thử model dự phòng**. Delete: superadmin or the job's creator.
- **Superadmin tabs:** "Sản phẩm đích" (above) and "Cài đặt" (three model slugs, fallback
  switch, masked key status with a link to the Creative page where the key is entered).

## Data

- `ScaleTarget`: id, name, sku, blankFile?, blankDescription, unprintedParts, active,
  sortOrder, candidateFile?, candidateTaskId?, candidateStatus?, candidateError?, timestamps.
- `ScaleJob`: id, targetId, targetName (snapshot), model, status
  (`describing|running|done|failed`), designJson, prompt, sourceFile, resultFile?,
  providerTaskId?, resultUrl? (pending download), error?, cost?, durationMs?, parentJobId?
  (set by fallback/re‑run), createdBy?, createdAt, completedAt?. Index on createdAt.
- Settings in `AppSetting` under `scale.*`.
- Files: `storageRoot()/scale/targets/<targetId>/blank.<ext>`,
  `storageRoot()/scale/jobs/<jobId>/{src,out}.<ext>`; served through an API route with the same
  whitelist approach as `resolveFile` in `src/lib/creative/storage.ts`.

Reuse from the Creative tool, do not copy: `kieClient` (`uploadBase64`, `schema`,
`createTask`, `poll`), `parseDataUrl` / `extForMime` / size limits, `getCreativeSecrets`,
`buildInput`. Where a helper is hard‑wired to the `creative` folder or `CreativeJob`, extend
it with a parameter rather than forking it.

## Access

- New permission `tools_scale` ("Scale sản phẩm", Tools group, ADMIN default, path
  `/tools/scale`), nav entry in `Sidebar.tsx`.
- `API_ACCESS_RULES`: `/api/tools/scale/targets` and `/api/tools/scale/settings` writes →
  `SUPERADMIN` (routes also call `requireSuperadmin`); everything else under
  `/api/tools/scale` → `['tools_scale']`.
- Routes that take an image body (`jobs`, `targets`) are excluded from the middleware matcher
  like `api/tools/creative/jobs` and call `requireApiAccess` themselves.
- Outbound downloads go through `assertSafeExternalUrl`. Keys are never returned unmasked.

## Constraints (CLAUDE.md)

- Schema change: migration folder built from `prisma migrate diff` (the CLI creates nothing on
  this PC), `prisma generate`, bump `SCHEMA_VERSION` in `src/lib/db.ts`.
- Tests on `test.db` only, own fixtures, fake fetch for Kie (pattern:
  `tests/creative-jobs.integration.test.ts`).
- Another session shares this checkout: build in a git worktree.
- UI text Vietnamese; code, prompts and this document English.

## Verification

- Unit: prompt assembly from a fixed target + design JSON (texts quoted, missing back view
  handled); settings defaults; access rules.
- Integration (fake Kie): happy path, vision failure, createTask 401 message, image‑step
  failure with fallback on/off, stale `describing`, unique upload names per job.
- Live, once, before calling it done: `source_varsity.jpg` from
  `D:\LZ POD ECOM\ads\mockups\star-wars-fleece-zip-hoodie\` → FEHOVN blank, compared by eye
  with `fleece-zip-hoodie-FEHOVN_v2_blankref.png` (the hand‑made result). If the key is not
  authorised for the image model, report that; the feature is then "built, not verified live".

  Live calls spend Kie credits and need a key that is authorised for the image model. The
  builder does not pull keys out of the prod database; the owner pastes a working key on the
  local `/tools/creative` page (or says which existing one to use). Until then the vision probe
  can still run on the local CS key.

## Where the build ends

A verified branch in a worktree, handed to the owner. Merge to `main`, push and the rollout
below happen only when the owner says so.

## Rollout (owner's go-ahead required)

1. Deploy (migration `scale_tool`; stop pm2 before `migrate deploy`).
2. nginx: allow large bodies for `/api/tools/scale/` (same block as the Creative one, which
   the owner still has to add).
3. Owner ticks `tools_scale` for staff in `/setup/users`.
4. Upload the FEHOVN blank, write its description, switch it on; make the other 13 blanks.

## Left to the builder

File layout, component split, exact vision system prompt, JSON field names, whether the blank's
Kie upload URL is cached between jobs, polling internals, wording of UI strings.
