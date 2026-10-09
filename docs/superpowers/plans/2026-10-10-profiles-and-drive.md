# Product Profiles + Drive Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (A) per-Shopify-product profiles that decide supplier, print template, master artwork and layer mapping for every variant; (B) artwork uploads stored on Google Drive via OAuth, uploaded browser→Drive directly, shared on approval.

**Architecture:** One migration adds `OrderLine.shopifyProductId`, `ProductProfile`, Drive columns on `DesignArtwork` and `DesignArtworkUpload`. Supplier resolution gains a profile step in the pure resolver `resolveByProductBase`; design lookups (`templateForLine`, master, layer hints) check the profile first. A thin `src/lib/google-drive.ts` wraps the Drive REST API with `fetch`; the upload path becomes session → browser PUT → complete, falling back to the v1 local path when Drive is not connected.

**Tech Stack:** Next.js 14.2 (sync `{ params }`), Prisma v7 SQLite, Vitest (mock `fetch` for Google), Tailwind tokens.

**Specs:** `docs/superpowers/specs/2026-10-10-product-profiles-design.md`, `docs/superpowers/specs/2026-10-10-drive-storage-design.md`.

## Global Constraints

- Never `url` in `datasource db {}`; after schema edits `npx prisma migrate dev --name <name>`, `npx prisma generate`, `SCHEMA_VERSION` in `src/lib/db.ts` `'v58'` → `'v59'` (only Task P1 changes the schema; all four model changes go in that one migration).
- `import { prisma } from '@/lib/db'`; Prisma types from `@/generated/prisma/client`; tests on test.db create/delete their own rows; never call real Google — mock `global.fetch`.
- Routes: `NextResponse.json`, sync `{ params }`, every new `/api/*` prefix covered by `API_ACCESS_RULES` (`/api/design-studio` is; add `/api/auth/google/callback` → `PUBLIC`, `/api/auth/google` → `SUPERADMIN`, `/api/setup/google-drive` → `SUPERADMIN` — put the callback rule before the `/api/auth/google` rule). Secrets/token-changing routes also call `requireSuperadmin(req)`.
- Never read Google secrets from the request except the Setup PUT that saves them; GET returns masked values.
- Pages `'use client'` + `<Sidebar />` layout; Tailwind tokens only; a11y labels; no comments unless non-obvious; imports at top.
- Commit per task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The dev server is stopped by the controller before P1 and restarted at the end; do not start one.

## Review Focus

1. Supplier precedence must be exactly variant manual > profile override > profile default > product base, and the size-sibling swap must still apply to profile results — pinned in P2.
2. Saving a profile must not re-resolve EXPORTED/FULFILLED/CANCELLED/REFUNDED orders — pinned in P3.
3. `complete` must refuse a Drive file that is not in the folder the session created (a designer cannot attach an arbitrary Drive file) — pinned in D2.
4. When Drive is not connected, uploads keep working on the local path — pinned in D2.
5. The callback must reject a missing/foreign `state` and never echo tokens — pinned in D1.

---

### Task P1: Schema + product id capture

**Files:** `prisma/schema.prisma`, migration, `src/lib/db.ts`, `src/lib/shopify-orders.ts` (both line-item queries + mapped types), `src/lib/repos/orders.ts`, `src/app/api/shopify/orders/sync/route.ts`, `src/lib/design-studio.ts` (`applyLineProps`, `refreshMissingLineProps` — treat a line with null `shopifyProductId` as missing too), tests.

- [ ] Schema per both specs: `OrderLine.shopifyProductId String?` + `@@index([shopifyProductId])`; `ProductProfile` (fields per spec, relations to `ShopifyStore`, `SupplierProduct?`, `PrintTemplate?`, unique `[storeId, shopifyProductId]`, `overrides String @default("[]")`, `layerMap String @default("[]")`); `DesignArtwork.storage String @default("LOCAL")`, `driveFileId String?`, `driveWebViewLink String?`, `storagePath String?`; `DesignArtworkUpload` per Drive spec (FK Order cascade, index `[orderId]`). Add back-relations on `ShopifyStore`, `SupplierProduct`, `PrintTemplate`, `Order`.
- [ ] Migrate, generate, bump to `v59`. Fix any TS fallout from `storagePath` becoming nullable (`readArtwork` returns null when `storagePath` is null for LOCAL).
- [ ] Shopify queries request `product { id … }`; map `productId: l.product?.id ?? null` on synced lines and `ShopifyOrderLineProps`.
- [ ] Persist: `UpsertOrderInput.lines[].shopifyProductId` (preserve-on-undefined like `imageUrl`), sync route passes it, `applyLineProps` writes it.
- [ ] Tests: upsert stores/preserves `shopifyProductId`; `applyLineProps` writes it; `refreshMissingLineProps` picks a line whose only missing field is `shopifyProductId`.
- [ ] `npx vitest run && npx tsc --noEmit -p .`; commit `feat(design-studio): capture Shopify product id; profile and Drive schema`.

### Task P2: Resolver precedence with profiles

**Files:** `src/lib/product-mapping.ts`, `src/app/api/shopify/orders/sync/route.ts` (load profiles for the store once per sync; pass the line's product id), any other caller of `resolveByProductBase` (grep; e.g. mapping recalculation, normalize scheduler) — pass `[]`/profiles accordingly, tests in `tests/product-mapping.test.ts` (extend) .

- [ ] Signature: `resolveByProductBase(variantId, productType, options, bases, manual, profile?: { supplierProductId: string | null; overrides: { combo: Record<string,string>; supplierProductId: string }[] } | null)`. After the manual-variant step and **before** the productType requirement: if `profile`, first override whose combo matches (reuse `matchesAttributeCombo`) → `{ resolvedVia: 'product_profile_override' }`; else `profile.supplierProductId` → `'product_profile'`; else fall through.
- [ ] In the sync route, `resolveSupplierProductIdForLine` applies the size-sibling swap to `'product_profile'` as it does to `'product_base_rank'`.
- [ ] Tests: manual beats profile; profile override beats profile default; profile beats a matching base; profile with null supplier falls through to bases; a line with no productType still resolves via profile; size swap for a profile result (integration test through the sync helper if it is exported, else unit-test the helper by extracting it to `src/lib/product-mapping.ts` as `swapToSizeSibling`).
- [ ] Full suite + tsc; commit `feat(mapping): product profile step in supplier resolution`.

### Task P3: Profile service, API, design precedence

**Files:** `src/lib/product-profiles.ts` (new), `src/lib/design-tasks.ts` (`templateForLine`, `loadTask`), `src/lib/design-studio.ts` (master artwork + layer hints in the workspace line), routes `src/app/api/design-studio/products/route.ts`, `products/[key]/route.ts`, tests.

- [ ] `product-profiles.ts`: `profileKey(storeId, productGid)` ↔ `parseProfileKey`; `observedFields(storeId, productGid)` (distinct `visibleCustomAttributes` keys over the product's lines, latest 200 lines); `profileStatus(profile, fields)` → `NONE|NO_TEMPLATE|NO_MASTER|NO_LAYERS|READY`; `listProducts({ q?, status? })` (group order lines of the last 90 days by store+product: title/image from newest line, variants seen, order count, open task count, status) ; `loadProduct(key)` (profile or null, summary, observed fields, supplier products of suppliers used by those lines or all active suppliers, templates); `saveProfile(key, input, actor)` (validate JSON shapes, FK existence, http(s) master URL via `safeHttpUrl`; upsert; then `reevaluateProduct(storeId, productGid)`).
- [ ] `reevaluateProduct`: for orders with a line of that product and `pipelineStatus` not in `EXPORTED, FULFILLED, CANCELLED, REFUNDED`, recompute `resolvedSupplierId/resolvedSupplierSku/resolvedBaseCost` for those lines the same way the manual-mapping route does (read `src/app/api/fulfillment/mapping/manual/route.ts` and reuse its recalculation helper; extract it to a lib function if it is inline), then `syncDesignTasks(orderId)`. Return `{ ordersUpdated, tasksTouched }`.
- [ ] `templateForLine(line)`: if a profile for `(order.storeId, line.shopifyProductId)` has `printTemplateId`, return that template; else existing logic. `loadTask` adds `profile: { key, status, masterArtworkUrl, layerMap } | null` to `TaskDetail`; master artwork shown in the workspace prefers the profile's.
- [ ] Routes: `GET /products` (`listProducts`), `GET /products/[key]`, `PUT /products/[key]` (`requireAdmin`; 400 on validation errors).
- [ ] Tests: `profileStatus` each state; `saveProfile` re-resolves an open order's line to the profile supplier and leaves an EXPORTED order untouched; template precedence in `loadTask`; route validation (bad override JSON → 400; non-admin PUT → 403).
- [ ] Full suite + tsc; commit `feat(design-studio): product profile service, API and design precedence`.

### Task P4: Products UI

**Files:** `src/app/design-studio/products/page.tsx`, `src/app/design-studio/products/[key]/page.tsx`, components under `src/app/design-studio/products/components/`, `src/components/Sidebar.tsx` (add "Sản phẩm" `inventory_2` after Design Tasks), `src/app/design-studio/components/TaskHeader.tsx` (link + "Lưu vào hồ sơ" button that PUTs the current layer hints merged into the profile), `TemplateCanvas.tsx` (accept an optional standalone mode: `template` + `masterUrl` without a task line).

- [ ] List page per spec (search, status filter chips, table rows with image/title/store/variants/orders/open tasks/status, row → editor).
- [ ] Editor per spec: left preview, right form (supplier product search select, overrides rows, template select filtered by supplier with link to Print Templates, master URL + upload (uses the artwork upload path with a synthetic slot — if the Drive tasks have not landed yet, link field only and a TODO-free note "upload sau khi nối Drive"), layer map table pre-filled from observed fields, notes), Save → shows `{ ordersUpdated, tasksTouched }`.
- [ ] Queue/tasks: "Hồ sơ đủ" pill when `detail.profile?.status === 'READY'`.
- [ ] tsc + `next lint --dir src/app/design-studio --dir src/components` + vitest; commit `feat(design-studio): products list and profile editor`.

### Task D1: Google Drive client + OAuth + Setup

**Files:** `src/lib/google-drive.ts`, `src/lib/google-oauth.ts` (state store like `saveOAuthState/consumeOAuthState` in `src/lib/token-store.ts`), routes `src/app/api/auth/google/route.ts`, `src/app/api/auth/google/callback/route.ts`, `src/app/api/setup/google-drive/route.ts`, `src/lib/api-access.ts`, Setup card component on `src/app/setup/page.tsx`, tests `tests/google-drive.test.ts`, `tests/google-oauth-routes.test.ts`.

- [ ] Functions per Drive spec. Token endpoint `https://oauth2.googleapis.com/token`; userinfo email via `https://www.googleapis.com/oauth2/v2/userinfo` (add scope `openid email` alongside `drive.file`); files API `https://www.googleapis.com/drive/v3/files`, uploads `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` with headers `Authorization`, `Content-Type: application/json; charset=UTF-8`, `X-Upload-Content-Type`, `X-Upload-Content-Length`, `Origin`. Folder search query `mimeType='application/vnd.google-apps.folder' and name='<escaped>' and '<parent>' in parents and trashed=false`.
- [ ] `isDriveConnected()` = refresh token + client id/secret present. Redirect URI built from `NEXT_PUBLIC_APP_URL` (fallback `http://localhost:3002`) + `/api/auth/google/callback`.
- [ ] Setup card: status (connected email, root folder link), client id (masked) / secret inputs, Connect (navigates to `/api/auth/google`), Disconnect.
- [ ] Tests with mocked fetch: token refresh cached until expiry; `ensureFolder` reuses an existing folder and creates when missing; resumable initiation sends `Origin` and returns the `Location` header; `shareAnyoneReader` posts `{role:'reader',type:'anyone'}`; callback rejects missing/unknown state with 400 and stores the refresh token on success (mock the token exchange); GET setup never returns the secret or token.
- [ ] Full suite + tsc; commit `feat(drive): Google Drive OAuth connection and client`.

### Task D2: Drive upload path, serving, sharing

**Files:** routes `src/app/api/design-studio/lines/[lineId]/artwork/session/route.ts`, `src/app/api/design-studio/artwork/complete/route.ts`, modify `src/app/api/design-studio/file/[artworkId]/route.ts`, `src/lib/design-storage.ts` (version allocation shared by local and Drive; `nextVersion`), `src/lib/design-studio.ts` (`updateLine` share + web link; `ArtworkRow` gains `storage`, `driveWebViewLink`), `src/app/design-studio/components/ArtworkSlots.tsx` (XHR upload with progress: session → PUT → complete; local fallback when the session route answers `{ mode: 'LOCAL' }`), tests.

- [ ] Session route: if `!isDriveConnected()` → `{ mode: 'LOCAL' }` (client then uses the v1 multipart route); else validate (extension allow-list, size ≤ 2 GB), `nextVersion`, `folderForTask`, `startResumableUpload` with `Origin` = request `origin` header, create `DesignArtworkUpload`, clean pending uploads older than 24 h, return `{ mode: 'DRIVE', uploadId, sessionUrl }`.
- [ ] Complete route: load the upload (404), idempotent if already completed (return the existing artwork), `getFile(driveFileId, 'id,name,parents,webViewLink,imageMediaMetadata,size')`, require `parents` includes `folderId` and `name` equals the recorded name (else 400), create `DesignArtwork` (`storage:'DRIVE'`, mime from the validated extension, width/height from metadata), mark completed, write a task UPLOAD event if a task exists for the line.
- [ ] Serve route: DRIVE → images/PDF streamed via `streamFile` (pass `Response.body` through), PSD/ZIP → 302 to `driveWebViewLink`.
- [ ] `updateLine(done:true)`: for a DRIVE artwork call `shareAnyoneReader` then set `designDriveLink = driveWebViewLink`; LOCAL unchanged.
- [ ] Tests (mock fetch + `isDriveConnected` via settings rows): session returns LOCAL when not connected; DRIVE session creates a pending row and returns the Location URL; complete rejects a foreign-folder file, accepts the right one, is idempotent; serve redirects PSD; `updateLine` on a DRIVE artwork calls the share endpoint and stores the web link.
- [ ] Full suite + tsc + lint; commit `feat(drive): direct-to-Drive artwork uploads, streaming and sharing`.

### Task Z: Docs

NOTES.md sections "Product profiles" and "Design artwork on Google Drive" (setup steps for the OAuth client exactly as in the Drive spec, scopes, redirect URIs, fallback, `drive.file` limitation: files added to Drive by hand are invisible to the app); PLAN.md line. Commit `docs(design-studio): product profiles and Drive storage`.
