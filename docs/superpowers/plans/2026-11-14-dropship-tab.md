# Dropship Tab Implementation Plan

> Executed natively in this session (owner said "làm đi"); one fresh reviewer on the whole branch at the end.

**Goal:** Dropship products skip design tasks and every design/file gate, send by CSV or Bondre API, and get a Dropship tab in Design Studio.

**Architecture:** `ProductProfile.dropship` is the source of truth; `OrderLine.dropship` is a copy written by order sync and by the product toggle. Two central predicates (`isLineApproved`, `isDesignOpen`) and one new helper (`needsDesign`) carry the rule; push builders branch on `line.dropship`.

**Tech Stack:** Next.js 14 app router, Prisma 7 + SQLite, vitest on test.db.

**Spec:** `docs/superpowers/specs/2026-11-14-dropship-tab-design.md`

## Global Constraints

- Never touch `dev.db` in tests; integration tests build their own fixtures.
- Migration from `prisma migrate diff` SQL (migrate dev is silent here); bump `SCHEMA_VERSION` in `src/lib/db.ts`.
- New `/api/*` route needs an `API_ACCESS_RULES` entry.
- UI copy in Vietnamese; dates MM/DD/YYYY.
- Event message exactly `Dropship — không cần design`; push refusal exactly `Dropship — gửi bằng CSV hoặc Bondre`.

## Review Focus

- Order with one POD line + one dropship line: POD line still needs its task/file; dropship line ready alone → test in Task 2.
- Toggling dropship OFF: lines lose the flag and get a design task again on next sync → test in Task 4.
- Dropship line with no Shopify image sent to Bondre → NO_MOCKUP error → test in Task 3.
- Closed/fulfilled orders are not rewritten by a toggle → test in Task 4.
- Dropship line without a supplier is not in Chờ gửi xưởng, only in Dropship → Chưa map → test in Task 4.

---

### Task 1: Schema + predicates
**Files:** `prisma/schema.prisma` (ProductProfile, OrderLine), new migration `20261114090000_dropship`, `src/lib/db.ts`, `src/lib/order-lines.ts`, `src/lib/public-artwork.ts`, `src/lib/line-export.ts`; test `tests/dropship-gates.test.ts`.
**Produces:** `needsDesign(line: { resolvedSupplierId: string | null; dropship?: boolean; sku?; productTitle; shopifyProductType? }): boolean` in `order-lines.ts` (= product line && supplier && !dropship). `isLineApproved` returns true when `line.dropship`. `isDesignOpen` returns false when `line.dropship`.
- [ ] Tests: needsDesign false for dropship; isLineApproved({designDriveLink:null,dropship:true}, {status:'NEW'}) true; isDesignOpen false for dropship with open task.
- [ ] Implement, migrate, generate, run, commit.

### Task 2: Design tasks + status inputs
**Files:** `src/lib/design-tasks.ts` (syncDesignTasks), `src/lib/shopify-order-sync.ts`, `src/lib/repos/design-reeval.ts`, `src/lib/repos/order-costs.ts`, `src/lib/repos/mapping.ts`, `src/lib/design-studio.ts`, `src/lib/design-library.ts` (designReadyHolds); test `tests/dropship-tasks.integration.test.ts`.
**Produces:** `dropshipProductIds(storeId: string): Promise<Set<string>>` in new `src/lib/dropship.ts`.
- [ ] Tests: sync on order with dropship line creates no task; existing NEW/REJECTED task → CANCELLED with event; POD sibling task created as before.
- [ ] Sync writes `dropship` per line; every `hasDesignLine`/`requiresDesign`/designReady computation uses `needsDesign`.
- [ ] Run, commit.

### Task 3: Push builders
**Files:** `src/lib/repos/bondre-push.ts`, `merchize-push.ts`, `printway-push.ts`, `pgprints-push.ts`; test `tests/dropship-push.integration.test.ts`.
- [ ] Bondre: dropship line skips NOT_APPROVED and `collectLineFiles`; item `design1:''`, `mockup1: line.imageUrl` (https only) else NO_MOCKUP. Others: dropship line → error code `DROPSHIP` with the refusal copy.
- [ ] Handoff hub: no NO_MOCKUP warning for dropship lines; `pendingHandoffWhere` OR `lines some dropship`.
- [ ] Tests for Bondre item shape, missing image, Merchize refusal; run, commit.

### Task 4: Toggle + Dropship API/tab
**Files:** `src/lib/dropship.ts` (`setProductDropship(storeId, shopifyProductId, on, title): Promise<{ lines: number; orders: number }>` — upsert profile, rewrite open lines, syncDesignTasksCounted + status recompute), `src/lib/repos/product-profiles.ts` (saveProfile accepts `dropship`), `src/app/api/design-studio/dropship/route.ts` (GET list), `src/lib/api-access.ts`, `src/app/design-studio/page.tsx` (mode `'dropship'` + count), new `src/app/design-studio/components/DropshipGrid.tsx`, product page toggle; test `tests/dropship-toggle.integration.test.ts`.
- [ ] Tests: toggle on rewrites open lines + cancels tasks, skips fulfilled order; toggle off clears flag; list groups unmapped vs mapped.
- [ ] Implement, run, commit.

### Task 5: Verify
- [ ] `npx vitest run` (full), `npx tsc --noEmit`, eslint on changed files, browser check of the tab on a prod-snapshot DB.
