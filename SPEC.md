# Ecom Manager — Technical Specification

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14.2 (App Router, TypeScript) |
| Styling | Tailwind CSS 3.4 (custom design tokens) |
| Icons | Material Symbols Outlined (Google Fonts) |
| Font | Inter (Google Fonts) |
| Database | SQLite via LibSQL (`dev.db` at project root) |
| ORM | Prisma v7.8 with `@prisma/adapter-libsql` |
| Runtime | Node.js (Next.js dev server, port 3002) |

---

## Project Structure

```
ecommanager-claude-ecommerce-cashflow-tool-XsLzh/
├── prisma/
│   ├── schema.prisma          # Source of truth for DB schema
│   ├── prisma.config.ts       # Prisma v7 config (datasource URL, migration path)
│   └── migrations/            # Applied migration SQL files
├── src/
│   ├── app/
│   │   ├── layout.tsx         # Root layout: loads Inter + Material Symbols fonts
│   │   ├── globals.css        # Base styles, font-face, Material Symbols settings
│   │   ├── page.tsx           # Overview dashboard (/)
│   │   ├── shopify/page.tsx   # Finance → Shopify (/shopify)
│   │   ├── projects/page.tsx  # Project Mgmt Dashboard (/projects)
│   │   ├── finance/
│   │   │   └── meta/page.tsx  # Finance → Meta Billing (/finance/meta)
│   │   └── setup/
│   │       ├── page.tsx       # Setup → Store (/setup)
│   │       ├── meta/page.tsx  # Setup → Meta (/setup/meta)
│   │       ├── projects/page.tsx  # Setup → Projects (/setup/projects)
│   │       └── hr/page.tsx    # Setup → HR (/setup/hr)
│   ├── api/
│   │   ├── auth/
│   │   │   ├── shopify/route.ts          # OAuth initiate
│   │   │   ├── shopify/callback/route.ts # OAuth callback
│   │   │   ├── shopify-config/route.ts   # Return OAuth config to client
│   │   │   └── status/route.ts           # Check connection status
│   │   ├── shopify/
│   │   │   ├── payouts/route.ts          # GET: fetch live from Shopify API
│   │   │   ├── payouts/[id]/route.ts     # GET: fetch transactions for a payout
│   │   │   ├── sync/route.ts             # POST: save payouts+bank+balance to DB
│   │   │   ├── db-payouts/route.ts       # GET: read payouts from DB
│   │   │   └── debug/route.ts            # Debug endpoint
│   │   ├── projects/
│   │   │   ├── route.ts                  # GET/POST/DELETE projects
│   │   │   ├── assign/route.ts           # POST/DELETE staff assignments
│   │   │   └── analytics/route.ts        # GET: profit analytics for a project
│   │   ├── staff/route.ts                # GET/POST/DELETE staff
│   │   └── meta/
│   │       ├── accounts/route.ts         # GET/POST/DELETE/PATCH meta ad accounts
│   │       ├── sync/route.ts             # POST: fetch billing from Meta Graph API
│   │       └── db-billing/route.ts       # GET: read billing from DB (SETTLED only)
│   ├── components/
│   │   └── Sidebar.tsx        # Shared sidebar with nested nav groups
│   ├── lib/
│   │   ├── db.ts              # Prisma singleton with SCHEMA_VERSION guard
│   │   ├── shopify.ts         # Shopify API helpers + TypeScript types
│   │   └── token-store.ts     # In-memory OAuth token store
│   └── generated/
│       └── prisma/            # Auto-generated Prisma client (do NOT edit)
├── dev.db                     # SQLite database (gitignored)
├── tailwind.config.ts         # Full design system tokens
├── .env                       # DATABASE_URL="file:./dev.db"
└── .eslintrc.json             # Disabled: no-explicit-any, no-page-custom-font
```

---

## Database Schema

```prisma
model ShopifyStore {
  id                     String        @id @default(cuid())
  shop                   String        @unique           // "store.myshopify.com"
  connectedAt            DateTime      @default(now())
  lastSyncAt             DateTime?
  currentBalance         Float?        // Saved on each sync
  currentBalanceCurrency String?
  payouts                Payout[]
  bankAccounts           BankAccount[]
}

model Payout {
  id                     Int           @id               // Shopify payout ID
  storeId                String
  status                 String        // paid | in_transit | scheduled | failed | canceled
  date                   String        // "YYYY-MM-DD"
  currency               String
  amount                 Float
  chargesFeeAmount       Float         @default(0)
  chargesGrossAmount     Float         @default(0)
  refundsFeeAmount       Float         @default(0)
  refundsGrossAmount     Float         @default(0)
  adjustmentsFeeAmount   Float         @default(0)
  adjustmentsGrossAmount Float         @default(0)
  bankAccountShopifyId   String?       // FK to BankAccount.id (Shopify's bank ID)
  fetchedAt              DateTime      @default(now())
  transactions           PayoutTransaction[]
}

model BankAccount {
  id            String        @id           // Shopify bank account ID (string)
  storeId       String
  accountNumber String
  bankName      String
  country       String
  currency      String
  status        String        // VALIDATED | PENDING
  fetchedAt     DateTime      @default(now())
}

model PayoutTransaction {
  id            Int           @id
  payoutId      Int
  type          String        // charge | refund | dispute | adjustment | ...
  currency      String
  amount        Float
  fee           Float
  net           Float
  sourceId      Int
  sourceType    String
  sourceOrderId Int?
  processedAt   DateTime
  fetchedAt     DateTime      @default(now())
}

model Project {
  id           String            @id @default(cuid())
  name         String
  startDate    DateTime
  description  String?
  createdAt    DateTime          @default(now())
  assignments  StaffAssignment[]
  metaAccounts MetaAdAccount[]
}

model Staff {
  id          String            @id @default(cuid())
  name        String
  role        String?
  monthlyCost Float             @default(0)
  note        String?
  createdAt   DateTime          @default(now())
  assignments StaffAssignment[]
}

model StaffAssignment {
  id        String    @id @default(cuid())
  staffId   String
  projectId String
  startDate DateTime  // Payouts AFTER this date → attributed to this staff
  endDate   DateTime?
  createdAt DateTime  @default(now())
  @@unique([staffId, projectId])
}

model MetaAdAccount {
  id          String        @id @default(cuid())
  accountId   String        @unique  // "act_123456789"
  accountName String?
  accessToken String        // Meta User/System token with ads_read permission
  currency    String?
  projectId   String?       // Optional link to a Project
  lastSyncAt  DateTime?
  createdAt   DateTime      @default(now())
  billings    MetaBilling[]
}

model MetaBilling {
  id          String        @id   // Meta transaction ID
  adAccountId String
  amount      Float
  currency    String
  billingDate String        // "YYYY-MM-DD"
  status      String        // SETTLED | REFUND | DECLINE | ...
  chargeType  String?
  productType String?
  createdAt   DateTime      @default(now())
}
```

---

## Prisma / DB Rules

- **Never add `url` to `datasource db {}` block in schema.prisma** — Prisma v7 reads URL only from `prisma.config.ts`
- **Always use `@prisma/adapter-libsql`** — Prisma v7 requires a driver adapter for SQLite
- **After any schema change**: run `npx prisma migrate dev --name <desc>` then `npx prisma generate` then **restart the dev server**
- **Bump `SCHEMA_VERSION`** in `src/lib/db.ts` after every schema change to force singleton reset
- **DB path**: `path.resolve(process.cwd(), 'dev.db')` — always absolute, always at project root
- **`prisma generate` cwd**: must be run from project root (`cd` to project dir first)

---

## Design System (Tailwind Tokens)

### Colors
```
primary:              #091426   (deep navy)
on-primary:           #ffffff
secondary:            #4b41e1   (indigo)
on-secondary:         #ffffff
surface:              #f7f9fb
surface-container:    #eef1f5
surface-container-low:    #f4f6f9
surface-container-lowest: #ffffff
surface-container-high:   #e4e8ee
on-surface:           #1a1c1e
on-surface-variant:   #44474e
outline-variant:      #c4c6d0
error:                #ba1a1a
on-tertiary-container: #00391f   (green for "positive/paid")
```

### Typography Scale
```
text-display-md    → 30px / 700
text-headline-sm   → 20px / 600
text-body-md       → 16px / 400
text-body-sm       → 14px / 400
text-label-md      → 14px / 500
text-label-sm      → 12px / 500
text-stats-lg      → 32px / 700
```

### Spacing Scale
```
p-xs / gap-xs / space-y-xs  → 4px
p-sm / gap-sm               → 8px
p-md / gap-md               → 16px
p-lg / gap-lg               → 24px
p-xl / gap-xl               → 32px
p-2xl                       → 48px
p-3xl                       → 64px
```

---

## Navigation Structure (Sidebar)

```
Overview                    /
─────────────────────────────
FINANCE
  └ Shopify                 /shopify
  └ Meta Billing            /finance/meta
─────────────────────────────
PROJECT MANAGEMENT
  └ Dashboard               /projects
─────────────────────────────
SETUP
  └ Store                   /setup
  └ Meta                    /setup/meta
  └ Projects                /setup/projects
  └ HR                      /setup/hr
```

---

## Key API Conventions

- All API routes return `NextResponse.json(data)` or `NextResponse.json({ error }, { status })`
- Shopify credentials passed via request headers (`x-shopify-shop-domain`, `x-shopify-access-token`, `x-shopify-api-version`) for manual mode; OAuth uses session cookie
- Meta API: Graph API v19.0, access token in query string
- All dates stored as `String` in "YYYY-MM-DD" format for payouts/billing (for simple SQLite string comparison sorting)
- DateTime fields (startDate, createdAt) stored as native SQLite DateTime

---

## Auth Flow

### Shopify OAuth
1. User enters shop domain on `/setup`, clicks Connect
2. `GET /api/auth/shopify?shop=X` → redirects to Shopify OAuth
3. Shopify redirects to `/api/auth/shopify/callback?code=X&shop=X`
4. Callback exchanges code for token, stores in `token-store.ts` (in-memory), sets cookie
5. `GET /api/auth/status` → returns `{ shopify: { connected, shop } }`

### Shopify Manual Credentials
- User enters shop domain + access token in Finance page
- Stored in `localStorage` under key `shopify_credentials_v1`
- Passed as headers on each API call

### Meta Ads
- User enters ad account ID + access token on `/setup/meta`
- Stored in `MetaAdAccount.accessToken` (plain text in SQLite)
- Used directly in Meta Graph API calls from server-side sync route
