# Ecom Manager — AI Agent Instructions

This file tells AI coding agents (Claude Code, Codex, etc.) how to work on this project correctly.

**Read these files first before making any changes:**
1. `SPEC.md` — architecture, DB schema, design tokens, API conventions
2. `PLAN.md` — what's done, what's next, known issues
3. `NOTES.md` — current state, active data, critical implementation quirks
4. `docs/superpowers/specs/` — active feature specs (in-progress designs). **Currently: Phase 13 Fulfillment & POD module is in brainstorming** — see `docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md` before touching any fulfillment/supplier/order code.

---

## Absolute Rules

### Database / Prisma
- **NEVER add `url` to the `datasource db {}` block** in `prisma/schema.prisma` — this breaks Prisma v7. URL lives only in `prisma.config.ts`.
- **After ANY schema change**, run ALL of these in order:
  ```bash
  cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
  npx prisma migrate dev --name <describe_change>
  npx prisma generate
  ```
  Then bump `SCHEMA_VERSION` in `src/lib/db.ts` (e.g. `'v4'` → `'v5'`), then restart the dev server.
- **Never import from `@/generated/prisma`** directly — always `@/generated/prisma/client`
- **Prisma singleton** is in `src/lib/db.ts` — use `import { prisma } from '@/lib/db'` everywhere

### Code Style
- All pages are `'use client'` React components (no RSC pages yet)
- Use Tailwind utility classes only — design tokens defined in `tailwind.config.ts`
- Use `material-symbols-outlined` for all icons: `<span className="material-symbols-outlined">icon_name</span>`
- No comments in code unless explaining a non-obvious constraint
- TypeScript: `any` is allowed (`@typescript-eslint/no-explicit-any` is disabled)

### UI / Design
- Follow the design token naming in `tailwind.config.ts` — e.g. `bg-primary`, `text-secondary`, `bg-surface-container-lowest`
- Card pattern: `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20`
- Section header pattern: `flex items-center gap-sm px-lg py-md border-b border-outline-variant/20`
- Buttons: primary action = `bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md`
- Sidebar uses `Sidebar` component from `src/components/Sidebar.tsx` — import and render in every page

### Adding New Pages
Every new page must:
1. Have `'use client'` at top
2. Import and render `<Sidebar />`
3. Wrap content in `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">...</main></div>`
4. Be added to the nav structure in `src/components/Sidebar.tsx`

### Adding New API Routes
- Route file: `src/app/api/<feature>/<action>/route.ts`
- Export named functions: `GET`, `POST`, `DELETE`, `PATCH`
- Always return `NextResponse.json(data)` or `NextResponse.json({ error: string }, { status: number })`
- Import prisma: `import { prisma } from '@/lib/db'`

---

## Development Workflow

```bash
# Start dev server (port 3002)
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm run dev -- --port 3002

# Schema change workflow
npx prisma migrate dev --name add_new_field
npx prisma generate
# Then bump SCHEMA_VERSION in src/lib/db.ts and restart server
```

---

## Current Priority: Phase 7 — Overview Dashboard

Build the Overview page at `src/app/page.tsx`.

### What to build
The page currently shows a placeholder. Replace it with:

**1. Create `GET /api/overview` route** at `src/app/api/overview/route.ts`:
```typescript
// Returns:
{
  shopify: {
    totalRevenue: number,    // sum of paid Payout.amount
    payoutCount: number,
    recentPayouts: Payout[]  // last 5, ordered by date desc
  },
  meta: {
    totalSpend: number,      // sum of SETTLED MetaBilling.amount
    billingCount: number,
    recentBillings: MetaBilling[]  // last 5
  },
  projects: {
    count: number,
    list: Array<{
      id, name, startDate,
      staffCount: number,
      monthlyCost: number   // sum of staff.monthlyCost for assigned staff
    }>
  },
  staff: {
    count: number,
    totalMonthlyCost: number
  },
  netCashflow: number   // totalRevenue - totalSpend
}
```

**2. Update `src/app/page.tsx`** to fetch from `/api/overview` and display:
- Top row: 4 stat cards (Total Revenue, Total Ad Spend, Net Cashflow, Active Projects)
- Middle: 2-column grid — Recent Payouts table + Recent Meta Billings table
- Bottom: Projects summary cards (one card per project with revenue/spend/net)

### Design reference
Look at how `/shopify/page.tsx` and `/projects/page.tsx` are structured — follow the same patterns.

---

## After Phase 7: Phase 8 — P&L per Project

Add to the Project Management Dashboard (`/projects/page.tsx` and `/api/projects/analytics`):
- Fetch Meta billing for the project's linked ad account in the same date range
- Staff cost = sum of `assignment.staff.monthlyCost` × (months between startDate and now/endDate)
- Show: Revenue (Shopify), Ad Spend (Meta), Staff Cost, **Net Profit**
- Formula: `Net = Revenue - AdSpend - StaffCost`
