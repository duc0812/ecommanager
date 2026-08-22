# Spy Tool — Phase A: Niche subsystem (user-defined keyword niches) — Design Spec

**Date:** 2026-08-22
**Status:** Draft for user review
**Part of:** the larger "brandsearch-style" restructure (Phase A → B nav/filter rail → C Best Seller). This spec is **Phase A only**: the Niche foundation.

---

## 1. Mục tiêu

Cho user tự định nghĩa **Niche** bằng luật keyword trên title (vd Disney = title chứa "dsny"/"disney"), rồi **lọc ads + products theo niche**. Đây là nền cho thanh filter Domain×Niche×Product type ở Phase B.

Ngoài phạm vi Phase A: thanh filter UI trong các view, nav 2-khu (Ad Library/Product Spy), Best Seller — đều thuộc Phase B/C.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Niche là gì | User tự định nghĩa: `name` + danh sách `keywords` |
| Khớp | title **chứa BẤT KỲ keyword** (OR), case-insensitive (Prisma `contains` trên SQLite = ASCII case-insensitive) |
| Áp cho | Products (product title) + Ads (ad `title` + `body`) |
| Lưu & tính | Bảng `SpyNiche` (rules) + khớp **lúc đọc** (không cột niche cố định; sửa rule đổi ngay) |
| Phase A scope | model + helper + `/api/spy/niches` CRUD + filter param `nicheId` trên ads/products + trang Setup Niche |

---

## 3. Data model (migration)

```prisma
model SpyNiche {
  id        String   @id @default(cuid())
  name      String   @unique
  keywords  String   @default("[]")   // JSON array of lowercase-insensitive substrings
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
}
```

Migration: `add_spy_niche`; bump `SCHEMA_VERSION` v27→v28.

---

## 4. Matching helper — `src/lib/spy/niche.ts` (thuần, test được)

```ts
export function parseKeywords(json: string | null | undefined): string[]
// parse JSON array; drop empties; trim. Non-array/invalid → [].

export function nicheMatches(title: string | null, keywords: string[]): boolean
// true if title (lowercased) contains ANY keyword (lowercased). Empty keywords/title → false.

export function nicheOrWhere(keywords: string[], fields: string[]): { OR: any[] } | undefined
// builds Prisma OR of { [field]: { contains: kw } } for each keyword × field.
// returns undefined when keywords is empty (caller then applies no niche filter).
```

- `nicheMatches`: for computing badges / unit-testing the rule.
- `nicheOrWhere`: for API where-clauses. Relies on Prisma `contains` → SQLite `LIKE '%kw%'` (ASCII case-insensitive). Keywords stored as-is; matching is case-insensitive via LIKE.

---

## 5. API

- **`GET/POST/PATCH/DELETE /api/spy/niches`**:
  - `GET`: list niches (ordered by name).
  - `POST {name, keywords}` — `keywords` accepts an array or a comma/newline string; normalize to a trimmed non-empty string array, `JSON.stringify` to store. `name` required (400 if blank). Upsert by `name`.
  - `PATCH {id, name?, keywords?, active?}`.
  - `DELETE {id}`.
- **`/api/spy/ads?nicheId=`**: load the niche, `parseKeywords`, apply `nicheOrWhere(keywords, ['title','body'])` merged into the existing `where` (combine with storeId/domainId via `AND`). If niche has no keywords → no niche narrowing (returns all, per existing behavior). Keep existing `filter`/signals unchanged.
- **`/api/spy/products?nicheId=`**: same with `nicheOrWhere(keywords, ['title'])`, merged into the existing `firstSeenAt`/`storeId` where via `AND`.

*(When both a domain/store filter and niche are present, combine with `AND: [ existingWhere, nicheOrWhere ]` so both apply.)*

---

## 6. Setup UI — `src/app/tools/spy-idea/niches/page.tsx`

- `'use client'`, `<RoleGate>` + `<Sidebar/>`, layout `ml-[280px] flex-1 p-xl`, render `SpySectionNav` (add a **Niches** item, icon `sell`).
- Add niche: `name` input + `keywords` textarea (comma/newline separated) → POST.
- List niches: name · keyword chips · edit (inline keywords + save PATCH) · delete.
- Dates en-US where shown.

Add a `{ key:'niches', label:'Niches', icon:'sell', href:'/tools/spy-idea/niches' }` entry to `SpySectionNav` items on the pages that render it (spy-idea + dashboard) so it's reachable. (Full nav restructure is Phase B.)

---

## 7. Non-goals (Phase A)
- No filter dropdowns wired into Ad Library / Product Spy views (Phase B).
- No 2-area nav restructure (Phase B).
- No Best Seller (Phase C).
- No hard-assigned niche column on products/ads (compute-at-read only).
- Product type filter (already `SpyProduct.productType`) — wired in Phase B.

---

## 8. File changes

### New
- `src/lib/spy/niche.ts` + `src/lib/spy/niche.test.ts`.
- `src/app/api/spy/niches/route.ts`.
- `src/app/tools/spy-idea/niches/page.tsx`.

### Modified
- `prisma/schema.prisma` (`SpyNiche`); `src/lib/db.ts` v27→v28.
- `src/app/api/spy/ads/route.ts` (nicheId filter).
- `src/app/api/spy/products/route.ts` (nicheId filter).
- `src/components/SpySectionNav.tsx` consumers (add Niches item) — or just add the nav item where SpySectionNav is used.

---

## 9. Testing
- `niche.ts` — unit (parseKeywords: array/string/invalid; nicheMatches: any-keyword, case-insensitive, empty; nicheOrWhere: OR shape per field, undefined when empty).
- `/api/spy/niches`, ads/products nicheId — tsc/lint (runtime via UI).
- Setup Niche UI — tsc/lint + manual.

---

## 10. Phân phase implement (cho writing-plans)
1. `SpyNiche` model + migration + `niche.ts` helper (+test).
2. `/api/spy/niches` CRUD + nicheId filter on ads/products.
3. Setup Niche UI + nav entry.
