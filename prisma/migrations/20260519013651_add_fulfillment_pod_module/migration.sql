-- AlterTable
ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "apiType" TEXT,
    "apiKey" TEXT,
    "firstItemShipFee" REAL NOT NULL DEFAULT 0,
    "additionalItemShipFee" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "preferenceRank" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT,
    "baseCost" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupplierCostHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "oldCost" REAL NOT NULL,
    "newCost" REAL NOT NULL,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierCostHistory_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "shippingCountry" TEXT,
    "shippingState" TEXT,
    "financialStatus" TEXT NOT NULL,
    "fulfillmentStatus" TEXT,
    "pipelineStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "grossAmount" REAL NOT NULL,
    "expectedPayout" REAL NOT NULL,
    "totalFees" REAL NOT NULL DEFAULT 0,
    "refundedAmount" REAL NOT NULL DEFAULT 0,
    "defaultSupplierId" TEXT,
    "exportedAt" DATETIME,
    "exportedToSupplierId" TEXT,
    "placedAt" DATETIME NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "sku" TEXT,
    "variantTitle" TEXT,
    "productTitle" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "resolvedSupplierId" TEXT,
    "resolvedBaseCost" REAL,
    "costSnapshotAt" DATETIME,
    CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CsvTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "columns" TEXT NOT NULL,
    "rowMode" TEXT NOT NULL DEFAULT 'PER_LINE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CsvTemplate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopifyStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" DATETIME,
    "currentBalance" REAL,
    "currentBalanceCurrency" TEXT,
    "syncSinceDate" DATETIME,
    "projectId" TEXT,
    CONSTRAINT "ShopifyStore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ShopifyStore" ("connectedAt", "currentBalance", "currentBalanceCurrency", "id", "lastSyncAt", "shop") SELECT "connectedAt", "currentBalance", "currentBalanceCurrency", "id", "lastSyncAt", "shop" FROM "ShopifyStore";
DROP TABLE "ShopifyStore";
ALTER TABLE "new_ShopifyStore" RENAME TO "ShopifyStore";
CREATE UNIQUE INDEX "ShopifyStore_shop_key" ON "ShopifyStore"("shop");
CREATE UNIQUE INDEX "ShopifyStore_projectId_key" ON "ShopifyStore"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");

-- CreateIndex
CREATE INDEX "SupplierProduct_sku_idx" ON "SupplierProduct"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_sku_key" ON "SupplierProduct"("supplierId", "sku");

-- CreateIndex
CREATE INDEX "SupplierCostHistory_supplierId_sku_idx" ON "SupplierCostHistory"("supplierId", "sku");

-- CreateIndex
CREATE INDEX "Order_placedAt_idx" ON "Order"("placedAt");

-- CreateIndex
CREATE INDEX "Order_pipelineStatus_idx" ON "Order"("pipelineStatus");

-- CreateIndex
CREATE INDEX "Order_defaultSupplierId_idx" ON "Order"("defaultSupplierId");

-- CreateIndex
CREATE INDEX "Order_projectId_idx" ON "Order"("projectId");

-- CreateIndex
CREATE INDEX "Order_projectId_placedAt_idx" ON "Order"("projectId", "placedAt");

-- CreateIndex
CREATE INDEX "OrderLine_sku_idx" ON "OrderLine"("sku");
