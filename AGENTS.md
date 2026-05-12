# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Dự án là gì

**Ecommerce Cashflow Manager** — Internal tool quản lý cashflow cho nhiều dự án ecommerce, theo dõi dòng tiền thực tế từ nhiều nguồn thu và chi.

### Công thức cashflow

```
Cashflow thực tế =
  + Shopify Payments payout
  + PayPal received
  + Stripe received
  - Facebook Ads billing (gắn label thủ công theo dự án)
  - Fulfillment costs (nhập tay hoặc upload hóa đơn)
  - Business ops (Shopify fee, server, tool, AI...)
```

### Hai chiều phân loại bắt buộc trên mỗi transaction

- **Project label** — transaction này thuộc dự án nào
- **Card** — transaction này thanh toán qua thẻ nào (để track total spent per card)

### Facebook Ads — cách xử lý đặc biệt

Một tài khoản FB Ads có thể chạy nhiều dự án. Tool pull **toàn bộ invoices** về, sau đó nhân sự **gắn label thủ công** cho từng invoice thuộc dự án nào. Cashflow của project X chỉ tính invoices đã được label = project X. Invoice chưa label → hiện warning trên dashboard.

---

## Development approach

**Data-first, feature-by-feature.** Không thiết kế DB schema trước. Với mỗi nguồn dữ liệu (Shopify, PayPal, Stripe, Facebook Ads), quy trình là:

1. Viết API client → fetch raw data thực tế từ API
2. Build trang explorer để xem raw data, hiểu structure
3. Từ real data → thiết kế schema chính xác
4. Build feature collect + hiển thị
5. Lặp lại với nguồn tiếp theo

Thứ tự triển khai: Shopify Payments → PayPal → Stripe → Facebook Ads → Manual entry → Cashflow engine → Dashboard UI

---

## Tech stack (planned)

| Layer | Choice |
|---|---|
| Framework | Next.js 14 App Router |
| Database | PostgreSQL + Prisma ORM |
| Auth | NextAuth v4 (credentials provider) |
| UI | shadcn/ui + Tailwind CSS |
| Charts | Recharts |
| Validation | Zod |
| Encryption | AES-256 (built-in crypto) cho API credentials |

> **Hiện tại (Phase 0):** Chưa có DB. Đang ở giai đoạn data exploration — chỉ có Next.js + Tailwind + Shopify client.

---

## Cấu trúc hiện tại

```
src/
├── app/
│   ├── api/shopify/
│   │   ├── payouts/route.ts          ← GET all payouts + balance stats
│   │   └── payouts/[id]/route.ts     ← GET balance transactions của 1 payout
│   └── shopify/page.tsx              ← Raw data explorer UI (client component)
└── lib/
    └── shopify.ts                    ← Shopify API client (fetch, types, pagination)
```

---

## Commands

```bash
npm run dev      # dev server tại localhost:3000
npm run build    # production build
npm run lint     # ESLint
```

---

## Environment variables

Tạo `.env.local` từ `.env.example`:

```env
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-04
```

Shopify custom app cần permission: **`read_shopify_payments_payouts`**

---

## Shopify API client (`src/lib/shopify.ts`)

Ba hàm chính:

- `fetchAllPayouts(params?)` — tự paginate qua Link header, trả `ShopifyPayout[]`
- `fetchPayoutTransactions(payoutId)` — balance transactions của 1 payout
- `fetchBalance()` — current store balance

Pagination dùng `Link: <url>; rel="next"` header của Shopify, không dùng cursor hay page number.

---

## Data explorer

`/shopify` — trang để review raw payout data trước khi thiết kế schema:
- Filter theo date range
- Hiển thị tất cả payouts với summary fields
- Click "View txns" → xem balance transactions chi tiết của từng payout
- Raw JSON toggle để inspect structure thực tế

---

## Schema dự kiến (chưa implement)

Sau khi collect đủ data từ tất cả nguồn, schema sẽ gồm các bảng chính:

```
User, Project, ProjectMember (OWNER/EDITOR/VIEWER)
Card                    ← thẻ thanh toán, shared across projects
Transaction             ← unified cho mọi loại thu/chi
  - projectId, cardId
  - type: INCOME | EXPENSE
  - category: SHOPIFY_PAYOUT | PAYPAL | STRIPE | FB_ADS | FULFILLMENT | BUSINESS_OPS
  - source: API | MANUAL
  - externalId           ← để tránh duplicate khi sync
Label                   ← tags tự do per project
TransactionLabel        ← junction table
Integration             ← credentials (encrypted) cho mỗi platform
SyncLog
```

Chi tiết đầy đủ: `docs/superpowers/plans/2026-05-12-cashflow-foundation.md`

---

## Phân quyền

| Role | Phạm vi |
|---|---|
| ADMIN | Toàn bộ hệ thống |
| OWNER | Toàn quyền trong project |
| EDITOR | Xem + thêm/sửa transaction |
| VIEWER | Chỉ xem |

---

## Integrations cần build (theo thứ tự)

| Platform | Loại | Status |
|---|---|---|
| Shopify Payments | INCOME — payout | 🔄 Data explorer done, schema pending |
| PayPal | INCOME — received | ⏳ Chưa bắt đầu |
| Stripe | INCOME — payout | ⏳ Chưa bắt đầu |
| Facebook Ads | EXPENSE — billing invoice | ⏳ Chưa bắt đầu |
| Manual entry | EXPENSE — fulfillment, ops | ⏳ Chưa bắt đầu |
