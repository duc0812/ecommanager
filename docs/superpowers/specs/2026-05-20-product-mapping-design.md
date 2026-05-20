# Product Mapping — Design Spec
Date: 2026-05-20

## Overview

Thêm module **Product Mapping** để tự động khớp order line từ Shopify với supplier product. Thay thế heuristic hiện tại trong `auto-mapping.ts` bằng hệ thống rule có cấu trúc, với 2 giao diện rõ ràng: **Auto Mapping** (rule-based) và **Manual Mapping** (per-product, priority tuyệt đối).

---

## 1. Data Model — 4 entity mới

### `ProductBase`
Định nghĩa "khuôn" sản phẩm. Là anchor cho toàn bộ mapping logic.

```prisma
model ProductBase {
  id                  String   @id @default(cuid())
  name                String
  shopifyProductType  String
  variantConditions   String   // JSON: [{optionName, value | anyOf}]
  notes               String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  supplierMappings    ProductBaseSupplierMapping[]
  overrides           ProductBaseOverride[]
  variantMappings     VariantManualMapping[]
}
```

### `ProductBaseSupplierMapping`
Liên kết ProductBase với nhiều SupplierProduct theo rank.

```prisma
model ProductBaseSupplierMapping {
  id                String          @id @default(cuid())
  productBaseId     String
  supplierProductId String
  preferenceRank    Int

  productBase       ProductBase     @relation(...)
  supplierProduct   SupplierProduct @relation(...)
}
```

### `ProductBaseOverride`
Ngoại lệ cho attribute combo cụ thể — override supplier mặc định (priority 2).

```prisma
model ProductBaseOverride {
  id                String          @id @default(cuid())
  productBaseId     String
  supplierProductId String
  attributeCombo    String          // JSON: {"Size": "6XL"}
  notes             String?

  productBase       ProductBase     @relation(...)
  supplierProduct   SupplierProduct @relation(...)
}
```

### `VariantManualMapping`
Override tại Shopify variant ID cụ thể — priority 1 tuyệt đối.

```prisma
model VariantManualMapping {
  id                  String          @id @default(cuid())
  shopifyVariantId    String          @unique
  shopifyProductTitle String
  variantTitle        String
  supplierProductId   String
  productBaseId       String?
  notes               String?
  createdAt           DateTime        @default(now())

  supplierProduct     SupplierProduct @relation(...)
  productBase         ProductBase?    @relation(...)
}
```

---

## 2. Priority Chain

Khi resolve một OrderLine:

```
1. VariantManualMapping (shopifyVariantId)     → priority 1, tuyệt đối
2. ProductBaseOverride (productBaseId + attrs) → priority 2
3. ProductBaseSupplierMapping (rank cao nhất)  → priority 3 (auto)
4. Không match                                  → PENDING_MAPPING ⛔
```

**AND logic** cho `variantConditions`: tất cả conditions phải đúng cùng lúc mới match ProductBase. `value` là exact match, `anyOf` là match nếu variant option value nằm trong danh sách.

**Rank:** `preferenceRank` là số nguyên, số nhỏ hơn = ưu tiên cao hơn (rank 1 > rank 2). Query `ORDER BY preferenceRank ASC LIMIT 1`.

**AttributeCombo matching:** Tất cả key-value trong `attributeCombo` JSON phải khớp với variant options của OrderLine. Ví dụ `{"Size":"6XL"}` chỉ match variant có option Size = "6XL".

---

## 3. Order Sync Flow

```
For each OrderLine khi sync:
  1. Check VariantManualMapping by shopifyVariantId → dùng luôn nếu có
  2. Match ProductBase: shopifyProductType + variantOptions phải pass ALL conditions
     a. Tìm ProductBaseOverride khớp attributeCombo → dùng nếu có
     b. Dùng ProductBaseSupplierMapping rank cao nhất
  3. Không match → set OrderLine.resolvedSupplierSku = null, status = PENDING_MAPPING
     Manual Mapping queue là view derived từ OrderLine WHERE status = PENDING_MAPPING (không phải bảng riêng)

Khi user Save trong Manual Mapping:
  → Lưu VariantManualMapping
  → Tất cả OrderLine có cùng shopifyVariantId đang PENDING_MAPPING → chuyển sang PENDING
```

---

## 4. UI — Trang `/fulfillment/mapping`

### Tab 1: Auto Mapping
- Bảng ProductBase: tên, shopifyProductType, conditions (tags), suppliers (ranked), special cases count
- Nút "+ New Product Base"
- Click "Edit" → mở modal

**Edit Modal gồm 4 section:**
1. **Thông tin cơ bản** — name + shopifyProductType
2. **Match Conditions** — mỗi condition là 1 row: option name + tag input cho values (nhập Enter để tạo tag, click ✕ để xóa)
3. **Suppliers theo Rank** — mỗi rank hiển thị: tên SupplierProduct + tên Supplier + SKU + sizes. Nút "Đổi" để chọn lại từ danh sách SupplierProduct
4. **Special Cases** — mỗi case: tag input cho attribute combo + chọn SupplierProduct override

### Tab 2: Manual Mapping
- Banner: "Mapping ở đây override tất cả Auto Mapping rules, priority 1"
- **Sub-tab Pending** — queue PENDING_MAPPING: product title, variant, SKU, số orders bị blocked, dropdown chọn SupplierProduct, nút Save
- **Sub-tab Saved Mappings** — danh sách VariantManualMapping đã lưu, có thể edit/xóa
- Tab badge đỏ hiển thị số pending

---

## 5. Sidebar Navigation

Thêm mục "Product Mapping" vào sidebar dưới section Fulfillment, trước hoặc sau "Products".

---

## 6. Scope Không Bao Gồm

- Bulk import ProductBase từ CSV
- Drag-and-drop reorder rank (dùng số rank trực tiếp)
- Webhook realtime khi có pending mới (dùng badge count khi load trang)
- API endpoint public cho mapping rules
