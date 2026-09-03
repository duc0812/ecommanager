-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SkuSupplierDesign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "designLink" TEXT,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "trelloCardId" TEXT,
    "note" TEXT,
    "parentCode" TEXT,
    "matchMode" TEXT NOT NULL DEFAULT 'VARIANT',
    "designType" TEXT NOT NULL DEFAULT 'NON_CUSTOM',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkuSupplierDesign_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SkuSupplierDesign" ("createdAt", "designLink", "designType", "id", "note", "parentCode", "ready", "sku", "source", "supplierId", "trelloCardId", "updatedAt") SELECT "createdAt", "designLink", "designType", "id", "note", "parentCode", "ready", "sku", "source", "supplierId", "trelloCardId", "updatedAt" FROM "SkuSupplierDesign";
DROP TABLE "SkuSupplierDesign";
ALTER TABLE "new_SkuSupplierDesign" RENAME TO "SkuSupplierDesign";
CREATE INDEX "SkuSupplierDesign_sku_idx" ON "SkuSupplierDesign"("sku");
CREATE INDEX "SkuSupplierDesign_parentCode_supplierId_idx" ON "SkuSupplierDesign"("parentCode", "supplierId");
CREATE INDEX "SkuSupplierDesign_supplierId_idx" ON "SkuSupplierDesign"("supplierId");
CREATE INDEX "SkuSupplierDesign_trelloCardId_idx" ON "SkuSupplierDesign"("trelloCardId");
CREATE UNIQUE INDEX "SkuSupplierDesign_sku_supplierId_key" ON "SkuSupplierDesign"("sku", "supplierId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
