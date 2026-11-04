-- CreateTable
CREATE TABLE "SupplierSheetWrite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "tabName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WRITING',
    "rowRange" TEXT,
    "baseCost" REAL,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SupplierSheetWrite_orderId_idx" ON "SupplierSheetWrite"("orderId");

-- CreateIndex
CREATE INDEX "SupplierSheetWrite_orderLineId_idx" ON "SupplierSheetWrite"("orderLineId");

-- CreateIndex
CREATE INDEX "SupplierSheetWrite_supplierId_createdAt_idx" ON "SupplierSheetWrite"("supplierId", "createdAt");
