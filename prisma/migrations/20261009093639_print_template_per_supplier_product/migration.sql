-- AlterTable
ALTER TABLE "PrintTemplate" ADD COLUMN "sourceFileName" TEXT;
ALTER TABLE "PrintTemplate" ADD COLUMN "sourceFilePath" TEXT;

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
    "textureOfMaterial" TEXT,
    "printTemplateId" TEXT,
    CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierProduct_printTemplateId_fkey" FOREIGN KEY ("printTemplateId") REFERENCES "PrintTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SupplierProduct" ("baseCost", "baseSku", "createdAt", "currency", "designTemplateUrl", "id", "maxProductionDays", "minProductionDays", "productName", "productType", "requiresDesign", "shippingByRegion", "sku", "supplierId", "textureOfMaterial", "updatedAt", "variant1Name", "variant1Value", "variant2Name", "variant2Value") SELECT "baseCost", "baseSku", "createdAt", "currency", "designTemplateUrl", "id", "maxProductionDays", "minProductionDays", "productName", "productType", "requiresDesign", "shippingByRegion", "sku", "supplierId", "textureOfMaterial", "updatedAt", "variant1Name", "variant1Value", "variant2Name", "variant2Value" FROM "SupplierProduct";
DROP TABLE "SupplierProduct";
ALTER TABLE "new_SupplierProduct" RENAME TO "SupplierProduct";
CREATE INDEX "SupplierProduct_sku_idx" ON "SupplierProduct"("sku");
CREATE INDEX "SupplierProduct_baseSku_idx" ON "SupplierProduct"("baseSku");
CREATE INDEX "SupplierProduct_printTemplateId_idx" ON "SupplierProduct"("printTemplateId");
CREATE UNIQUE INDEX "SupplierProduct_supplierId_sku_key" ON "SupplierProduct"("supplierId", "sku");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
