# Duyệt sản xuất: giao diện theo xưởng, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Màn "Duyệt sản xuất" chia tab theo xưởng, card cao cố định có base cost và product type, bấm card mở task.

**Architecture:** Server trả danh sách tab nhẹ cho mọi đơn chờ và card của đúng một tab. Client dùng hàm thuần `hubView` để lọc dòng theo xưởng và tính cảnh báo. Kênh ghi sheet là kế hoạch riêng, chưa thuộc bước này.

**Tech Stack:** Next.js 14 App Router, Prisma + SQLite, Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-production-hub-design.md`

## Global Constraints

- Card cao cố định khoảng 172px, một cột trên điện thoại, chữ dài cắt bằng "…".
- Giới hạn 60 card áp theo từng xưởng, số trên tab là số thật.
- Không đổi luồng API, không đổi tab "Đã chuyển xưởng".
- Ở kênh API và CSV cảnh báo chỉ để nhìn, nút giữ nguyên.
- Ngày hiển thị dạng en-US, chữ giao diện tiếng Việt.

## Review Focus

1. Tìm một đơn đang ở xưởng khác tab hiện tại: phải thấy đơn và số trên tab đúng theo kết quả tìm.
2. Đơn nhiều xưởng: mỗi tab chỉ tính dòng chưa gửi của xưởng đó, cost không cộng dòng xưởng khác.
3. Thao tác trong cửa sổ gửi xưởng trên card không được mở task.
4. Dòng thứ hai của đơn bị cảnh báo: card vẫn phải hiện cảnh báo dù card hiển thị dòng đầu.
5. Đơn có dòng chưa map: hiện ở tab "Chưa map xưởng" và không làm lỗi phần xây card.

---

### Task 1: Dữ liệu tab và card theo xưởng

**Files:** Modify `src/lib/handoff-shared.ts`, `src/lib/supplier-handoff.ts`, `src/app/api/design-studio/handoff/route.ts`. Test `tests/supplier-handoff.integration.test.ts`.

**Interfaces — Produces:**
- `HandoffLine` thêm `baseCost: number | null` (đơn giá hiệu lực nhân số lượng) và `productType: string | null`.
- `HubTab = { id: string; name: string; channel: 'API' | 'CSV' | null; orderCount: number; baseCostTotal: number }`, `UNMAPPED_TAB = 'none'`.
- `listHandoffTabs({ q? }): Promise<HubTab[]>`, sắp theo `orderCount` giảm dần, tab chưa map ở cuối.
- `listHandoffCards({ q?, supplierId? }): Promise<{ pending: HandoffCard[]; selected: string | null }>`.
- GET `/api/design-studio/handoff?supplier=<id>` trả thêm `tabs`, `selected`.

- [ ] Viết test: đơn nhiều xưởng có ở cả hai tab với cost riêng; tab chưa map; quá 60 card vẫn đúng số; `q` tìm thấy đơn ở tab khác và `selected` tự chuyển; dòng đã xuất không tính.
- [ ] Chạy test, phải fail.
- [ ] Viết code: `buildCards` có `withUnmapped`; lọc theo xưởng ở query.
- [ ] Chạy `npx vitest run tests/supplier-handoff.integration.test.ts`, phải pass.
- [ ] Commit.

### Task 2: `hubView`

**Files:** Create `src/lib/handoff-hub.ts`, test `src/lib/handoff-hub.test.ts`.

**Interfaces — Produces:** `hubView(card: HandoffCard, tabId: string)` trả `{ lines, first, extra, baseCost, costMissing, warnings, mixed }`. `warnings` gồm `{ code: 'WRONG_SIZE' | 'MAPPING' | 'NO_MOCKUP', taskKey }`. Có mockup nghĩa là có file MOCKUP hoặc `previewUrl`.

- [ ] Viết test cho lọc theo xưởng, bỏ dòng đã xuất, cost cộng đúng, thiếu giá, cảnh báo ở dòng thứ hai.
- [ ] Viết code, test pass, commit.

### Task 3: Giao diện

**Files:** Create `src/app/design-studio/components/HubCard.tsx`. Modify `HandoffGrid.tsx`, `src/app/design-studio/page.tsx`.

- [ ] `HubCard`: cao cố định, bấm vào mở task dòng đầu, vùng nút chặn lan sự kiện.
- [ ] `HandoffGrid`: tab cuộn ngang, đầu tab có kênh, số đơn, tổng cost, link CSV Export khi kênh CSV, ô tìm kiếm cho điện thoại. `OrderCard` giữ nguyên cho "Đã chuyển xưởng".
- [ ] `page.tsx`: dưới `lg` ẩn cột danh sách ở `handoff`, `sent` và khi đang mở task.
- [ ] `npx tsc --noEmit`, eslint các file đã sửa, commit.

### Task 4: Cảnh báo trong task

**Files:** Create `src/app/design-studio/components/PreSendChecks.tsx`, `TaskHandoffChecks.tsx`. Modify `src/app/api/design-studio/orders/[id]/handoff/route.ts`, `TaskHeader.tsx` hoặc nơi hiển thị task, `HandoffGrid.tsx`.

**Interfaces — Produces:** GET handoff route trả `{ card: HandoffCard | null }` qua `handoffCardFor(orderId)`, chỉ gọi khi `detail.handoff.pending`.

- [ ] Viết test route, chạy fail.
- [ ] Viết code, tải lười để không làm chậm mở task, test pass, commit.

### Task 5: Kiểm tra thật

- [ ] Chạy local trên bản sao DB prod. Kiểm tra 375px và desktop: card bằng nhau, không tràn ngang, bấm card mở task, bấm nút không mở task.
- [ ] Deploy chỉ khi chủ shop đồng ý.
