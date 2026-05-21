UPDATE "Order"
SET "pipelineStatus" = 'READY_TO_PRODUCTION'
WHERE "pipelineStatus" IN ('PENDING');

UPDATE "Order"
SET "pipelineStatus" = 'EXPORTED'
WHERE "pipelineStatus" IN ('SUPPLIER_PROCESSING', 'IN_PRODUCTION');

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
    "pipelineStatus" TEXT NOT NULL DEFAULT 'READY_TO_PRODUCTION',
    "currency" TEXT NOT NULL,
    "grossAmount" REAL NOT NULL,
    "subtotalAmount" REAL NOT NULL DEFAULT 0,
    "shippingAmount" REAL NOT NULL DEFAULT 0,
    "taxAmount" REAL NOT NULL DEFAULT 0,
    "expectedPayout" REAL NOT NULL,
    "totalFees" REAL NOT NULL DEFAULT 0,
    "refundedAmount" REAL NOT NULL DEFAULT 0,
    "defaultSupplierId" TEXT,
    "exportedAt" DATETIME,
    "exportedToSupplierId" TEXT,
    "placedAt" DATETIME NOT NULL,
    "shopTimezone" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "shippingZone" TEXT,
    "shippingName" TEXT,
    "shippingAddress1" TEXT,
    "shippingAddress2" TEXT,
    "shippingCity" TEXT,
    "shippingZip" TEXT,
    "shippingPhone" TEXT,
    "orderType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "trelloCardId" TEXT,
    "trelloCardUrl" TEXT,
    "designReady" BOOLEAN NOT NULL DEFAULT false,
    "designDriveLink" TEXT,
    CONSTRAINT "Order_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Order" ("currency", "customerEmail", "customerName", "defaultSupplierId", "designDriveLink", "designReady", "expectedPayout", "exportedAt", "exportedToSupplierId", "fetchedAt", "financialStatus", "fulfillmentStatus", "grossAmount", "id", "orderType", "pipelineStatus", "placedAt", "projectId", "refundedAmount", "shippingAddress1", "shippingAddress2", "shippingAmount", "shippingCity", "shippingCountry", "shippingName", "shippingPhone", "shippingState", "shippingZip", "shippingZone", "shopTimezone", "shopifyOrderNumber", "storeId", "subtotalAmount", "taxAmount", "totalFees", "trelloCardId", "trelloCardUrl", "updatedAt")
SELECT "currency", "customerEmail", "customerName", "defaultSupplierId", "designDriveLink", "designReady", "expectedPayout", "exportedAt", "exportedToSupplierId", "fetchedAt", "financialStatus", "fulfillmentStatus", "grossAmount", "id", "orderType", "pipelineStatus", "placedAt", "projectId", "refundedAmount", "shippingAddress1", "shippingAddress2", "shippingAmount", "shippingCity", "shippingCountry", "shippingName", "shippingPhone", "shippingState", "shippingZip", "shippingZone", "shopTimezone", "shopifyOrderNumber", "storeId", "subtotalAmount", "taxAmount", "totalFees", "trelloCardId", "trelloCardUrl", "updatedAt"
FROM "Order";

DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";

CREATE INDEX "Order_placedAt_idx" ON "Order"("placedAt");
CREATE INDEX "Order_pipelineStatus_idx" ON "Order"("pipelineStatus");
CREATE INDEX "Order_defaultSupplierId_idx" ON "Order"("defaultSupplierId");
CREATE INDEX "Order_projectId_idx" ON "Order"("projectId");
CREATE INDEX "Order_projectId_placedAt_idx" ON "Order"("projectId", "placedAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
