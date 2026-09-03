-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "variantOptions" TEXT,
    "sku" TEXT,
    "resolvedSupplierSku" TEXT,
    "variantTitle" TEXT,
    "productTitle" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "linePosition" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" REAL NOT NULL,
    "resolvedSupplierId" TEXT,
    "resolvedBaseCost" REAL,
    "manualBaseCost" REAL,
    "costSnapshotAt" DATETIME,
    "resolvedShipFirst" REAL,
    "resolvedShipAdditional" REAL,
    "resolvedImportTax" REAL,
    "shopifyProductType" TEXT,
    "previewCdnUrl" TEXT,
    "designDriveLink" TEXT,
    "customized" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OrderLine" ("costSnapshotAt", "designDriveLink", "id", "linePosition", "manualBaseCost", "orderId", "previewCdnUrl", "productTitle", "qty", "resolvedBaseCost", "resolvedImportTax", "resolvedShipAdditional", "resolvedShipFirst", "resolvedSupplierId", "resolvedSupplierSku", "shopifyLineId", "shopifyProductType", "shopifyVariantId", "sku", "unitPrice", "variantOptions", "variantTitle") SELECT "costSnapshotAt", "designDriveLink", "id", "linePosition", "manualBaseCost", "orderId", "previewCdnUrl", "productTitle", "qty", "resolvedBaseCost", "resolvedImportTax", "resolvedShipAdditional", "resolvedShipFirst", "resolvedSupplierId", "resolvedSupplierSku", "shopifyLineId", "shopifyProductType", "shopifyVariantId", "sku", "unitPrice", "variantOptions", "variantTitle" FROM "OrderLine";
DROP TABLE "OrderLine";
ALTER TABLE "new_OrderLine" RENAME TO "OrderLine";
CREATE INDEX "OrderLine_sku_idx" ON "OrderLine"("sku");
CREATE INDEX "OrderLine_shopifyVariantId_idx" ON "OrderLine"("shopifyVariantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
