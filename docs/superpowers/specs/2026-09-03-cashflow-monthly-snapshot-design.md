# Cashflow Monthly Snapshot — Design

**Ngày:** 2026-09-03
**Trạng thái:** Design (chờ review)

## 1. Vấn đề

Con số "Dòng tiền dự kiến (đến ngày X)" trên trang project (`/projects`) tính **đúng tại mỗi thời điểm**, nhưng **drift theo thời gian** khi xem lại cùng một kỳ đã đóng:

- **Payout settling:** payout `in_transit`/`scheduled` → `paid` sau kỳ, mang `date` rơi vào trong kỳ → `totalPayout` của kỳ đã đóng tăng dần.
- **COGS maturing:** order chưa map SKU dùng COGS ước tính (`knownCogs + (payout − knownCogs)/2`, xem `src/lib/order-profit.ts`). Khi map dần, ước tính được thay bằng cost thật → số đổi.

Vì vậy không thể tái tạo "dòng tiền đến 31/7 như nó vốn có ngày 31/7". Người dùng muốn tính **profit theo tháng** = chênh lệch dòng tiền dự kiến tích lũy giữa 2 mốc cuối tháng liên tiếp, nên cần **đóng băng (snapshot)** giá trị tại mỗi mốc cuối tháng.

**Đây không phải bug công thức** — công thức giữ nguyên. Giải pháp là lưu snapshot.

## 2. Mục tiêu

- Tự động chốt snapshot dòng tiền tích lũy (từ đầu dự án → cuối tháng) cho từng project vào cuối mỗi tháng.
- Cho phép tính **profit tháng N = snapshot(cuối tháng N) − snapshot(cuối tháng N−1)**.
- Mở rộng **Projected Cashflow**: trừ thêm **nợ Meta chưa charge** (`balance` của ad account — đã tiêu, chưa bị trừ tiền) như một dòng ra dự kiến tại thời điểm sync.
- Không đổi hành vi/con số của trang analytics hiện tại (ngoài việc bổ sung `pendingInvoiceCharge` vào Projected).
- Không đụng chạm dữ liệu hiện có (chỉ thêm bảng + cột mới; không sửa/xoá bản ghi cũ).

### Ngoài phạm vi (YAGNI)
- Không snapshot theo tuần/ngày.
- Không snapshot mức tổng hợp toàn công ty (chỉ per-project). Có thể cộng dồn ở UI sau nếu cần.
- Không sửa cách tính COGS (người dùng yêu cầu giữ nguyên).

## 3. Quyết định thiết kế (đã chốt với người dùng)

| Vấn đề | Quyết định |
|---|---|
| Khoảng tính snapshot | **Tích lũy**: từ `project.startDate` → cuối tháng đó |
| Profit tháng | Hiệu 2 snapshot liên tiếp |
| Cách tạo | **Tự động theo lịch (node-cron)** + nút chốt lại thủ công |
| Biên "cuối tháng" | Theo **timezone store của project** (như analytics) |
| Backfill | **Có** — tạo snapshot mọi tháng từ đầu dự án bằng data hiện tại |
| Lưu gì | **Toàn bộ breakdown thành phần** (không chỉ 1 số) để tính profit theo actual-basis hoặc projected-basis |
| Nợ Meta chưa charge | Lấy từ **`balance` của Meta API** (đáng tin hơn tự tính `DailyAdSpend − MetaBilling`); trừ vào Projected, point-in-time tại thời điểm sync |

## 4. Ngữ nghĩa quan trọng (caveat)

`projectedCashflow = actualCashflow(khoảng ngày) + shopifyBalance + inTransitPayout + pendingPayout − pendingInvoiceCharge`

- `actualCashflow(start→cuối tháng)` **có mốc thời gian** → hiệu 2 snapshot = dòng tiền phát sinh trong tháng (cash-basis sạch). **Không** gồm `pendingInvoiceCharge` (giữ actual = tiền thực chi/thực nhận).
- `pendingInvoiceCharge` = tổng hoá đơn chưa charge, **point-in-time**, dòng ra dự kiến, chỉ nằm ở Projected. **Hiện tại nguồn duy nhất là Meta ads** (`balance` các account, quy USD); tên đặt tổng quát để sau bổ sung nguồn invoice khác mà không đổi schema.
- `shopifyBalance`, `inTransitPayout`, `pendingInvoiceCharge` là **point-in-time** (giá trị hiện tại, không gắn tháng). Khi backfill (tính lại các tháng cũ tại cùng một thời điểm hiện tại), các phần này giống nhau giữa các snapshot → **triệt tiêu khi trừ**; chỉ phần có mốc thời gian tạo ra chênh lệch. Khi chạy đúng lịch về sau, chúng phản ánh "tiền treo tại thời điểm chốt".

→ Vì vậy snapshot lưu đầy đủ breakdown. UI cho chọn tính profit theo:
- **actual-basis** (mặc định): `actualCashflow(N) − actualCashflow(N−1)` — sạch, không nhiễu balance/in-transit.
- **projected-basis**: `projectedCashflow(N) − projectedCashflow(N−1)` — gồm biến động tiền treo.

**Giới hạn:** snapshot các tháng đã qua (backfill) dùng data đã matured, **không** phải "as-of" gốc của tháng đó. Chỉ snapshot từ nay về sau (chạy đúng lịch) mới là as-of thật. Chấp nhận được vì hiệu 2 snapshot backfill vẫn cô lập hoạt động của tháng cho phần có mốc thời gian.

## 5. Kiến trúc

### 5.1 Data model — `prisma/schema.prisma`

```prisma
model CashflowSnapshot {
  id                String   @id @default(cuid())
  projectId         String
  project           Project  @relation(fields: [projectId], references: [id])
  periodMonth       String   // 'YYYY-MM' — tháng của kỳ (cuối tháng)
  asOfDate          String   // 'YYYY-MM-DD' — ngày cuối tháng theo tz store (biên tính)
  takenAt           DateTime @default(now()) // lúc job/route thật sự chạy

  // Breakdown (tích lũy từ project.startDate → asOfDate)
  totalPayout       Float
  totalMetaBilling  Float
  metaFxFee         Float
  totalOrderCogs    Float
  totalOtherCosts   Float
  actualCashflow    Float
  shopifyBalance    Float
  inTransitPayout   Float
  pendingPayout     Float
  pendingInvoiceCharge Float    // nợ Meta chưa charge (Σ balance), quy USD, point-in-time lúc chốt
  projectedCashflow Float

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([projectId, periodMonth])
  @@index([projectId])
}
```

Thêm `snapshots CashflowSnapshot[]` vào model `Project`.

Thêm cột vào model `MetaAdAccount` (nợ chưa charge, point-in-time):
```prisma
  balance         Float?    // nợ chưa charge, đơn vị major theo currency account
  balanceCurrency String?
  balanceSyncedAt DateTime?
```

Migration chỉ `CREATE TABLE CashflowSnapshot` + `ALTER TABLE MetaAdAccount ADD COLUMN` (3 cột nullable) — additive, không sửa/xoá dữ liệu cũ.

### 5.1b Sync `balance` từ Meta — `src/lib/meta-billing-sync.ts`

- Mở rộng `fetchPaymentMethod` (đang gọi node account với `fields=funding_source,funding_source_details,currency,timezone_name`) → thêm `balance` vào `fields`.
- Parse `balance` về **đơn vị major**: Meta trả số ở minor unit theo currency (USD chia 100; VND/JPY zero-decimal giữ nguyên). Dùng bảng zero-decimal-currency để chuẩn hoá; **verify format thực tế Meta trả khi code** (viết test cho parser).
- Lưu `balance`, `balanceCurrency = account.currency`, `balanceSyncedAt = now()` vào `MetaAdAccount`.
- `balance` là point-in-time; mỗi lần sync ghi đè giá trị mới nhất.

### 5.2 Refactor — tách phép tính: `src/lib/repos/cashflow.ts`

Hiện toàn bộ phép tính nằm inline trong `src/app/api/projects/analytics/route.ts` (~355 dòng). Tách phần tính cashflow ra:

```ts
export type ProjectCashflowResult = {
  totalPayout, totalMetaBilling, metaFxFee, totalOrderCogs, totalOtherCosts,
  actualCashflow, shopifyBalance, inTransitPayout, pendingPayout,
  pendingInvoiceCharge, projectedCashflow,
  // ... các trường khác route đang trả (totalRevenue, grossProfit, spendByAccount, v.v.)
}

export async function computeProjectCashflow(opts: {
  projectId: string
  startDate: Date        // đã resolve (project start hoặc theo filter)
  endDate: Date
  timeZone: string
  startStr: string       // date-key biên đã resolve
  endStr: string
}): Promise<ProjectCashflowResult>
```

- Route `analytics/route.ts` giữ nguyên phần resolve khoảng ngày/tz/filter staff, rồi gọi `computeProjectCashflow(...)` cho phần tính.
- Snapshot job gọi cùng hàm với `startDate = project.startDate`, `endDate = cuối tháng`, `timeZone = tz store`.
- `pendingInvoiceCharge` = Σ `convertMetaAmountToUsdDated(account.balance, account.balanceCurrency, today, schedule)` cho các account của project (bỏ qua account thiếu tỷ giá, cộng cờ cảnh báo). Trừ vào `projectedCashflow`.

**Ràng buộc bất biến:** output JSON của route analytics phải **giống hệt** trước/sau refactor **cho các trường cũ**; `projectedCashflow` đổi do thêm `−pendingInvoiceCharge` (thay đổi có chủ đích, test 8.1 chốt riêng giá trị cũ và giá trị mới).

### 5.3 Scheduler — `src/lib/cashflow-snapshot-scheduler.ts`

Theo pattern `src/lib/auto-sync.ts` / `src/lib/tracking/scheduler.ts` (node-cron in-process, `init...()` idempotent).

```ts
export async function runMonthEndSnapshots(now = new Date()): Promise<...>
export function initCashflowSnapshotScheduler(): void
```

- Cron `0 0 1 * *` (00:00 ngày 1 mỗi tháng). Khi chạy → chốt cho **tháng vừa kết thúc**.
- Với mỗi project chưa `archivedAt`:
  - Xác định tz store project (fallback `'UTC'`).
  - `asOfDate` = ngày cuối tháng vừa qua theo tz store; `endDate` = cuối ngày đó; `startDate` = `project.startDate`.
  - Gọi `computeProjectCashflow`, `upsert` `CashflowSnapshot` theo `(projectId, periodMonth)`.
- Ghi kết quả run vào `AppSetting` key `last_cashflow_snapshot_result` (theo pattern hiện có).
- Đăng ký trong `src/instrumentation.ts` cạnh các `init...()` khác.

**Lưu ý timezone cron:** cron dùng 1 tz cố định để *fire*; biên tháng thật sự được tính theo tz store trong logic. Để tránh chốt sớm khi có store ở tz muộn hơn, fire ở tz sớm nhất hợp lý; vì hiện chỉ có store `America/Denver`, đặt cron timezone `America/Denver`. (Nếu sau này có store tz khác, job vẫn tính đúng biên theo tz từng project; chỉ thời điểm fire cần đủ trễ.)

### 5.4 API routes

- `POST /api/projects/[id]/snapshot` — chốt lại thủ công 1 tháng: body `{ month: 'YYYY-MM' }` (mặc định tháng hiện tại đang diễn ra hoặc tháng chỉ định) → tính & upsert. Dùng cho sửa/backfill lẻ.
- `POST /api/projects/snapshot/backfill` — chạy backfill mọi tháng từ `project.startDate` → tháng gần nhất đã kết thúc, cho 1 project hoặc tất cả. Idempotent (upsert).
- `GET /api/projects/[id]/snapshots` — trả danh sách snapshot + profit tháng đã tính sẵn (delta actual & projected).

### 5.5 UI — `src/app/projects/page.tsx`

Thêm section **"Profit theo tháng"** (card theo pattern `bg-surface-container-lowest rounded-xl ...`):

- Bảng: mỗi dòng 1 tháng (mới → cũ): `Tháng | Projected cuối tháng | Actual cuối tháng | Profit tháng`.
- Toggle basis: **Actual** (mặc định) / **Projected** → đổi cột Profit.
- Tháng đầu tiên (không có tháng trước): Profit = chính snapshot đó (tích lũy từ đầu dự án).
- Nút **"Chốt lại tháng này"** (gọi `POST .../snapshot`) và badge `takenAt` để biết snapshot cập nhật lúc nào.
- Trong nhóm Projected (section "Actual Cashflow" hiện có ở `page.tsx`): thêm card **`Pending Meta (nợ chưa charge)`** = `pendingInvoiceCharge`, và cập nhật hint công thức Projected thành `+ balance + in-transit − pending Meta`.

## 6. Data flow

```
cron 00:00 ngày 1 (America/Denver)
  └─ runMonthEndSnapshots()
       └─ mỗi project chưa archived
            ├─ resolve tz store, asOfDate = cuối tháng vừa qua
            ├─ computeProjectCashflow(start=project.startDate, end=asOfDate)
            └─ upsert CashflowSnapshot(projectId, periodMonth)

UI /projects
  └─ GET /api/projects/[id]/snapshots → bảng + delta profit
```

## 7. Error handling

- Job bọc try/catch **per-project** — 1 project lỗi không chặn project khác (theo pattern `runAutoSync`).
- Thiếu tz store → fallback `'UTC'`, vẫn chốt.
- Backfill idempotent: chạy lại ghi đè qua `upsert`, không tạo trùng.
- Nếu `computeProjectCashflow` gặp thiếu tỷ giá (missing exchange rate) → vẫn lưu snapshot với giá trị hiện có + cờ/ghi chú (không chặn), giống hành vi route hiện tại.

## 8. Testing

### 8.1 Characterization test (bắt buộc, trước refactor)
- Snapshot output JSON của `computeProjectCashflow` cho project LZ ở vài khoảng ngày → so khớp **giống hệt** con số route analytics trả trước khi refactor. Đây là chốt chặn "không đổi data/hành vi hiện tại".

### 8.2 Unit
- `computeProjectCashflow`: doanh thu/COGS/payout đúng với dữ liệu dựng sẵn; biên tháng theo tz.
- Xác định `asOfDate` cuối tháng theo tz store (gồm ca DST của `America/Denver`).
- Delta profit: `snapshot(N) − snapshot(N−1)` cho cả actual & projected basis; tháng đầu = chính nó.
- **Parser `balance` Meta**: minor→major đúng cho USD (chia 100) và VND/JPY (giữ nguyên); `pendingInvoiceCharge` quy USD đúng, bỏ qua account thiếu tỷ giá.
- `projectedCashflow` trừ đúng `pendingInvoiceCharge`; `actualCashflow` **không** bị ảnh hưởng.

### 8.3 Integration
- `runMonthEndSnapshots(now)` với DB seed → tạo đúng số snapshot, upsert idempotent khi chạy lại.
- Backfill từ `project.startDate` tạo đủ các tháng.

## 9. Tác động dữ liệu / triển khai

- **Additive**: thêm bảng `CashflowSnapshot` + 3 cột nullable trên `MetaAdAccount` (`balance`, `balanceCurrency`, `balanceSyncedAt`). Không `DROP`; các cột mới nullable nên bản ghi cũ giữ nguyên (`NULL`).
- `SCHEMA_VERSION` trong `src/lib/db.ts` chỉ tạo lại PrismaClient trong bộ nhớ, **không reset DB**.
- Workflow (theo CLAUDE.md): `npx prisma migrate dev --name add_cashflow_snapshot_and_meta_balance` → `npx prisma generate` → bump `SCHEMA_VERSION` (`v39` → `v40`) → restart dev.
- **Production (VPS):** deploy chạy `npx prisma migrate deploy` (không `migrate dev`). Migration thêm-bảng → an toàn, không mất data. Sau deploy chạy backfill 1 lần.

## 10. Files

**Thêm mới:**
- `src/lib/repos/cashflow.ts` — `computeProjectCashflow`
- `src/lib/cashflow-snapshot-scheduler.ts` — job + `initCashflowSnapshotScheduler`
- `src/app/api/projects/[id]/snapshot/route.ts` — chốt lại 1 tháng
- `src/app/api/projects/[id]/snapshots/route.ts` — GET danh sách + delta
- `src/app/api/projects/snapshot/backfill/route.ts` — backfill
- `prisma/migrations/<ts>_add_cashflow_snapshot/` — migration
- Test tương ứng ở `tests/` / cạnh file (theo pattern repo)

**Sửa:**
- `prisma/schema.prisma` — thêm model `CashflowSnapshot` + quan hệ `Project.snapshots`; thêm 3 cột `balance*` vào `MetaAdAccount`
- `src/lib/meta-billing-sync.ts` — fetch + lưu `balance` cho ad account
- `src/lib/repos/cashflow.ts` (mới) — tính `pendingInvoiceCharge` trong `computeProjectCashflow`
- `src/app/api/projects/analytics/route.ts` — gọi `computeProjectCashflow` thay vì tính inline
- `src/instrumentation.ts` — gọi `initCashflowSnapshotScheduler()`
- `src/app/projects/page.tsx` — section "Profit theo tháng" + card `Pending Meta`
- `src/lib/db.ts` — bump `SCHEMA_VERSION`
