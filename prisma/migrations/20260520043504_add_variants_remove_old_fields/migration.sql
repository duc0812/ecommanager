-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SupplierProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT,
    "baseCost" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "requiresDesign" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "baseSku" TEXT,
    "productType" TEXT,
    "variant1Name" TEXT,
    "variant1Value" TEXT,
    "variant2Name" TEXT,
    "variant2Value" TEXT,
    "designTemplateUrl" TEXT,
    "minProductionDays" INTEGER,
    "maxProductionDays" INTEGER,
    "shippingByRegion" TEXT,
    CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SupplierProduct" ("id", "supplierId", "sku", "productName", "baseCost", "currency", "requiresDesign", "updatedAt", "createdAt", "baseSku", "productType", "variant1Name", "variant1Value", "variant2Name", "variant2Value", "designTemplateUrl", "minProductionDays", "maxProductionDays", "shippingByRegion")
SELECT "id", "supplierId", "sku", "productName", "baseCost", "currency", "requiresDesign", "updatedAt", "createdAt", "baseSku", "productType", CASE WHEN "sizeLabel" IS NOT NULL AND "sizeLabel" != '' THEN 'Size' ELSE NULL END, "sizeLabel", NULL, NULL, "designTemplateUrl", "minProductionDays", "maxProductionDays", "shippingByRegion" FROM "SupplierProduct";
DROP TABLE "SupplierProduct";
ALTER TABLE "new_SupplierProduct" RENAME TO "SupplierProduct";
CREATE INDEX "SupplierProduct_sku_idx" ON "SupplierProduct"("sku");
CREATE INDEX "SupplierProduct_baseSku_idx" ON "SupplierProduct"("baseSku");
CREATE UNIQUE INDEX "SupplierProduct_supplierId_sku_key" ON "SupplierProduct"("supplierId", "sku");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
