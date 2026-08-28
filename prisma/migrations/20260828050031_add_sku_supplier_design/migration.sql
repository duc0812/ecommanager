-- CreateTable
CREATE TABLE "SkuSupplierDesign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "designLink" TEXT,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "trelloCardId" TEXT,
    "note" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkuSupplierDesign_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SkuSupplierDesign_sku_idx" ON "SkuSupplierDesign"("sku");

-- CreateIndex
CREATE INDEX "SkuSupplierDesign_supplierId_idx" ON "SkuSupplierDesign"("supplierId");

-- CreateIndex
CREATE INDEX "SkuSupplierDesign_trelloCardId_idx" ON "SkuSupplierDesign"("trelloCardId");

-- CreateIndex
CREATE UNIQUE INDEX "SkuSupplierDesign_sku_supplierId_key" ON "SkuSupplierDesign"("sku", "supplierId");
