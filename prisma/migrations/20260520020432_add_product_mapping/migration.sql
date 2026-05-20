-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "shopifyVariantId" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "variantOptions" TEXT;

-- CreateTable
CREATE TABLE "ProductBase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "shopifyProductType" TEXT NOT NULL,
    "variantConditions" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductBaseSupplierMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productBaseId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "preferenceRank" INTEGER NOT NULL,
    CONSTRAINT "ProductBaseSupplierMapping_productBaseId_fkey" FOREIGN KEY ("productBaseId") REFERENCES "ProductBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductBaseSupplierMapping_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductBaseOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productBaseId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "attributeCombo" TEXT NOT NULL,
    "notes" TEXT,
    CONSTRAINT "ProductBaseOverride_productBaseId_fkey" FOREIGN KEY ("productBaseId") REFERENCES "ProductBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductBaseOverride_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VariantManualMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "supplierProductId" TEXT NOT NULL,
    "productBaseId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VariantManualMapping_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VariantManualMapping_productBaseId_fkey" FOREIGN KEY ("productBaseId") REFERENCES "ProductBase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProductBase_shopifyProductType_idx" ON "ProductBase"("shopifyProductType");

-- CreateIndex
CREATE INDEX "ProductBaseSupplierMapping_productBaseId_idx" ON "ProductBaseSupplierMapping"("productBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBaseSupplierMapping_productBaseId_preferenceRank_key" ON "ProductBaseSupplierMapping"("productBaseId", "preferenceRank");

-- CreateIndex
CREATE INDEX "ProductBaseOverride_productBaseId_idx" ON "ProductBaseOverride"("productBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantManualMapping_shopifyVariantId_key" ON "VariantManualMapping"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "VariantManualMapping_shopifyVariantId_idx" ON "VariantManualMapping"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "OrderLine_shopifyVariantId_idx" ON "OrderLine"("shopifyVariantId");
