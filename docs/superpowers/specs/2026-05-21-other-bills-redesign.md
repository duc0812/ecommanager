# Other Bills Redesign — Design Spec

**Date:** 2026-05-21
**Status:** Approved

## Summary

Full redesign of the Other Bills feature. Replace the existing 22-field accounting-heavy form with a simple 10-field expense tracker. Migrate the Prisma schema (no existing data to preserve). Rebuild the page UI from scratch.

## Problem

The current form has ~22 fields with accounting jargon (Expense Recognition, Accounting Basis, Accrual/Cash, Recognition Date, Allocation Note, Expense Account) that is confusing and unnecessary for recording simple recurring expenses like app fees, subscriptions, and office costs.

## Use Cases

- Monthly app/tool fees (Shopify, spy tools)
- Subscriptions (Proxy, VPS, Server)
- Office expenses
- Any paid expense with optional project label

## New Prisma Schema

Replace the entire `OtherBill` model in `prisma/schema.prisma`:

```prisma
model OtherBill {
  id            String   @id @default(cuid())
  vendor        String
  category      String
  amount        Float
  currency      String   @default("USD")
  amountUsd     Float
  exchangeRate  Float?
  paidAt        String
  paymentMethod String
  transactionId String?
  note          String?
  tags          String   @default("[]")
  projectId     String?
  project       Project? @relation(fields: [projectId], references: [id])
  createdAt     DateTime @default(now())

  @@index([paidAt])
  @@index([category])
  @@index([projectId])
}
```

**Removed from old schema:** invoiceNumber, dueDate, serviceStartDate, serviceEndDate, expenseAccount, subtotalAmount, taxAmount, paymentStatus, paymentDate, allocationNote, documentUrl/Name/MimeType/Size, accountingBasis, recognitionDate, staffId, referenceNumber, updatedAt, notes.

**Migration:** Drop and recreate — no existing data to preserve.

## Categories

| Value | Label |
|---|---|
| `APP_TOOL` | App & Tool |
| `SUBSCRIPTION` | Subscription |
| `OFFICE` | Văn phòng |
| `OTHER` | Khác |

## Payment Methods

| Value | Label |
|---|---|
| `CK` | Chuyển khoản |
| `PINGPONG` | PingPong |
| `PO` | PO |
| `OTHER` | Khác |

## Currency Logic

- Default currency: **USD**
- When currency = **VND**:
  - Show extra field: **Tỷ giá** (VND per 1 USD), e.g. 25400
  - Show live preview below: *"≈ $12.50 USD"*
  - `amountUsd = amount / exchangeRate`
  - `exchangeRate` is stored
- When currency = **USD**:
  - `amountUsd = amount`
  - `exchangeRate = null`

## Tags

- Stored as JSON array string in `tags` field: `'["LZ","Proxy","Remi05"]'`
- UI: chip input — user types a tag name and presses Enter to add, clicks × to remove
- Displayed as colored chips in the bill list

## Form Fields (10 fields)

| Field | Input type | Required | Default |
|---|---|---|---|
| Nhà cung cấp | text | ✓ | — |
| Danh mục | select | ✓ | — |
| Số tiền | number | ✓ | — |
| Tiền tệ | select (USD / VND) | ✓ | USD |
| Tỷ giá (VND only) | number | conditional | — |
| Ngày thanh toán | date | ✓ | today |
| Phương thức | select | ✓ | — |
| Transaction ID | text | — | — |
| Ghi chú | textarea | — | — |
| Tags | chip input | — | — |
| Dự án | select | — | — |

## API Routes

### `GET /api/finance/other-bills`

Query params: `month`, `projectId`, `category`, `paymentMethod`

Returns:
```typescript
{
  bills: OtherBill[],       // with project relation
  projects: Project[],
  stats: {
    totalUsd: number,
    count: number,
    byCategory: { category: string; totalUsd: number; count: number }[]
  }
}
```

### `POST /api/finance/other-bills`

JSON body (not FormData — no file upload in new design):
```typescript
{
  vendor: string
  category: string
  amount: number
  currency: string          // 'USD' | 'VND'
  exchangeRate?: number     // required if currency = VND
  paidAt: string            // YYYY-MM-DD
  paymentMethod: string
  transactionId?: string
  note?: string
  tags?: string             // JSON array string
  projectId?: string
}
```

Validation:
- `vendor`, `category`, `paidAt`, `paymentMethod` required
- `amount > 0`
- `exchangeRate > 0` required when `currency = 'VND'`
- `category` must be one of APP_TOOL | SUBSCRIPTION | OFFICE | OTHER
- `paymentMethod` must be one of CK | PINGPONG | PO | OTHER

Computes `amountUsd` server-side:
- If USD: `amountUsd = amount`
- If VND: `amountUsd = Math.round((amount / exchangeRate) * 100) / 100`

### `DELETE /api/finance/other-bills/[id]`

No changes needed — keep as-is.

## Page UI (`src/app/finance/other-bills/page.tsx`)

### Layout

Same 2-column layout: form on left (420px), list on right.

### Stats cards (4)

- **Tháng này** — total USD spent this month
- **Tổng giao dịch** — count
- **Danh mục nhiều nhất** — tên category có tổng amountUsd cao nhất tháng này
- **Dự án** — number of distinct projects with expenses

### Filter bar

Month picker · Category dropdown · Payment method dropdown · Project dropdown

### Bill table columns

| Nhà cung cấp | Danh mục | Số tiền | Ngày | Thanh toán | Tags | Dự án | |
|---|---|---|---|---|---|---|---|
| vendor bold + note small | category chip | amountUsd large · original small if VND | paidAt | method · transactionId small | colored chips | project name | Delete |

## Files Changed

| File | Action |
|---|---|
| `prisma/schema.prisma` | Replace OtherBill model |
| `src/app/finance/other-bills/page.tsx` | Full rewrite |
| `src/app/api/finance/other-bills/route.ts` | Full rewrite (GET + POST) |
| `src/app/api/finance/other-bills/[id]/route.ts` | Keep DELETE, remove PATCH |

## Migration Steps

```bash
npx prisma migrate dev --name simplify-other-bills
npx prisma generate
# Bump SCHEMA_VERSION in src/lib/db.ts
```
