-- CreateTable
CREATE TABLE "SkuDesign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "designReady" BOOLEAN NOT NULL DEFAULT false,
    "driveLink" TEXT,
    "trelloCardId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
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
    "shippingZone" TEXT,
    "orderType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "trelloCardId" TEXT,
    "trelloCardUrl" TEXT,
    CONSTRAINT "Order_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("currency", "customerEmail", "customerName", "defaultSupplierId", "expectedPayout", "exportedAt", "exportedToSupplierId", "fetchedAt", "financialStatus", "fulfillmentStatus", "grossAmount", "id", "pipelineStatus", "placedAt", "projectId", "refundedAmount", "shippingCountry", "shippingState", "shippingZone", "shopifyOrderNumber", "storeId", "totalFees", "updatedAt") SELECT "currency", "customerEmail", "customerName", "defaultSupplierId", "expectedPayout", "exportedAt", "exportedToSupplierId", "fetchedAt", "financialStatus", "fulfillmentStatus", "grossAmount", "id", "pipelineStatus", "placedAt", "projectId", "refundedAmount", "shippingCountry", "shippingState", "shippingZone", "shopifyOrderNumber", "storeId", "totalFees", "updatedAt" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE INDEX "Order_placedAt_idx" ON "Order"("placedAt");
CREATE INDEX "Order_pipelineStatus_idx" ON "Order"("pipelineStatus");
CREATE INDEX "Order_defaultSupplierId_idx" ON "Order"("defaultSupplierId");
CREATE INDEX "Order_projectId_idx" ON "Order"("projectId");
CREATE INDEX "Order_projectId_placedAt_idx" ON "Order"("projectId", "placedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SkuDesign_sku_key" ON "SkuDesign"("sku");
