# Meta Ads — Effective-dated exchange rate + dedicated Setup — Design Spec

**Date:** 2026-08-23
**Status:** Draft for user review
**Area:** Finance / Meta billing (not the spy tool).

---

## 1. Mục tiêu

Thay tỷ giá Meta "1 giá trị/account" bằng **lịch tỷ giá theo mốc ngày** (effective-dated), nhập ở **1 trang Setup riêng**. Quy đổi mỗi billing dùng tỷ giá **hiệu lực tại `billingDate`** của billing đó.

Ví dụ: nhập 22/06→26000, 22/07→25500 ⇒ billing 22/06–21/07 dùng 26000; từ 22/07 dùng 25500.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Phạm vi | **1 lịch chung**, chỉ áp cho account **non-USD (VND)**; account USD không quy đổi (giữ nguyên) |
| Ý nghĩa số | **VND per USD** (full number, vd 25500) — GIỮ NGUYÊN như hiện tại (`amount ÷ rate`). Không đổi đơn vị |
| Chọn rate | Theo `billingDate`: entry có `effectiveDate` lớn nhất mà ≤ billingDate |
| Trước mốc đầu | Billing có ngày < mốc sớm nhất → **dùng rate sớm nhất** |
| Nhập ở đâu | Trang Setup riêng (thêm/sửa/xoá các mốc `ngày → rate`) |
| Rate cũ /account | Migrate: seed lịch chung từ rate VND account hiện có (mốc rất sớm) để báo cáo cũ không đổi |

---

## 3. Data model (migration)

```prisma
model MetaExchangeRate {
  id            String   @id @default(cuid())
  effectiveDate String   @unique   // "YYYY-MM-DD"
  rate          Float               // VND per USD (units of source currency per 1 USD)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

- Global (không gắn account). `effectiveDate` dạng `YYYY-MM-DD` (so khớp trực tiếp với `MetaBilling.billingDate` là String cùng format → so sánh chuỗi = so sánh ngày).
- Migration `add_meta_exchange_rate`; bump `SCHEMA_VERSION`.

---

## 4. Helpers

### 4.1 `meta-currency.ts` — pure (test được)
```ts
export type DatedRate = { effectiveDate: string; rate: number }

// schedule sorted asc by effectiveDate. Trả rate hiệu lực cho `date`:
//  - entry lớn nhất có effectiveDate <= date;
//  - nếu date < mốc sớm nhất → rate của mốc sớm nhất;
//  - schedule rỗng → null.
export function rateForDate(schedule: DatedRate[], date: string): number | null

// Quy đổi 1 dòng theo ngày (USD giữ nguyên; non-USD dùng rateForDate; thiếu rate → null)
export function convertMetaAmountToUsdDated(
  amount: number, currency: string | null | undefined, billingDate: string, schedule: DatedRate[],
): number | null

// Tổng theo ngày; rows có {amount, currency, billingDate}
export function sumMetaAmountsUsdDated(
  rows: { amount: number; currency: string | null; billingDate: string }[], schedule: DatedRate[],
): { totalUsd: number; missingCount: number }
```
- `convertMetaAmountToUsd(amount, currency, rate)` cũ GIỮ NGUYÊN (dùng lại trong dated version + nơi khác).

### 4.2 `meta-exchange-rates.ts` — DB
```ts
export async function getMetaRateSchedule(): Promise<DatedRate[]>  // sorted asc
export async function addMetaRate(effectiveDate: string, rate: number): Promise<void>  // upsert theo effectiveDate
export async function deleteMetaRate(id: string): Promise<void>
```
- Giữ `getMetaExchangeRates`/`saveMetaExchangeRate` cũ tạm thời (deprecated) cho tới khi mọi call-site chuyển xong, rồi xoá.

---

## 5. Rewire call-sites (đổi từ map phẳng → lịch theo ngày)

Mọi nơi đang `getMetaExchangeRates(accountIds)` + `sumMetaAmountsUsd/convertMetaAmountToUsd`:
- `src/lib/repos/reports.ts` (`combinedProjectPL`): `sumMetaAmountsUsd(billings, rates)` → `sumMetaAmountsUsdDated(billings, schedule)`.
- `src/app/api/projects/profit-chart/route.ts`: `convertMetaAmountToUsd(amount, currency, rates.get(id))` per row → `convertMetaAmountToUsdDated(amount, currency, billingDate, schedule)`.
- `src/app/api/overview/route.ts`, `src/app/api/meta/db-billing/route.ts`, `src/app/api/projects/analytics/route.ts`: đổi tương tự (đảm bảo có `billingDate` trong rows).
- Task đầu sẽ **grep toàn bộ** `getMetaExchangeRates`/`sumMetaAmountsUsd` để không sót site nào.

Yêu cầu: mọi rows truyền vào phải kèm `billingDate` (MetaBilling đã có). USD vẫn giữ nguyên (rateForDate không áp cho USD).

---

## 6. Setup UI — trang tỷ giá riêng

- Trang mới `src/app/setup/meta-rates/page.tsx` (`'use client'`, Sidebar, RoleGate, layout chuẩn). Thêm vào nav Sidebar nhóm **Setup** (label "Meta Exchange Rate").
- Nội dung: bảng các mốc (ngày `YYYY-MM-DD` · rate) sắp theo ngày; form thêm mốc (date picker + rate); nút xoá mỗi dòng. Hint: "VND per USD, vd 25500". Hiển thị dates en-US.
- API `src/app/api/meta/exchange-rates/route.ts`: `GET` (list), `POST {effectiveDate, rate}` (upsert theo date), `DELETE {id}`. `force-dynamic`.
- Ở trang setup account Meta hiện tại (`src/app/setup/meta/page.tsx`): bỏ ô nhập tỷ giá/account (hoặc để read-only + link sang trang mới). Rate account cũ không dùng nữa cho quy đổi.

---

## 7. Migration / seed (lúc deploy)
- Sau migrate: seed `MetaExchangeRate` từ rate VND account hiện có (AppSetting `meta.exchangeRate.*`) → 1 entry `effectiveDate` sớm (vd '2000-01-01'), `rate` = giá trị đang lưu. Nhờ "trước mốc đầu → rate sớm nhất", mọi billing cũ quy đổi y như trước cho tới khi user thêm mốc mới.
- Việc seed là bước deploy (script), không nằm trong code app.

---

## 8. Non-goals
- Không tự fetch tỷ giá từ API ngoài (user nhập tay).
- Không đổi ý nghĩa số rate (vẫn VND per USD, full number).
- Không đụng OtherBills/currency.ts (VND hiển thị khác — ngoài phạm vi).
- Không xử lý nhiều loại tiền non-USD khác (chỉ VND theo yêu cầu; cơ chế vẫn generic theo currency !== USD).

---

## 9. Testing
- `rateForDate` — unit: trong khoảng, đúng mốc, trước mốc đầu (→ sớm nhất), rỗng (→ null), nhiều mốc.
- `convertMetaAmountToUsdDated` / `sumMetaAmountsUsdDated` — unit (USD giữ nguyên; VND theo ngày; thiếu → missing).
- `meta-currency.test.ts` cũ giữ xanh (convertMetaAmountToUsd không đổi).
- Call-sites + API + UI — tsc/lint + manual. Full suite (2 order-profit fail cũ không liên quan).

---

## 10. Phân phase (cho writing-plans)
1. `MetaExchangeRate` model + migration + `rateForDate`/`convertMetaAmountToUsdDated`/`sumMetaAmountsUsdDated` (pure, +test) + `getMetaRateSchedule`/`addMetaRate`/`deleteMetaRate`.
2. `GET/POST/DELETE /api/meta/exchange-rates` + rewire tất cả call-site quy đổi sang lịch theo ngày (grep sweep).
3. Trang Setup `/setup/meta-rates` + nav Sidebar + gỡ ô rate ở setup account Meta.
