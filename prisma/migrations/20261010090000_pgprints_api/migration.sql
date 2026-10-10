-- AlterTable
ALTER TABLE "DesignArtwork" ADD COLUMN "publicToken" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "shippingStateCode" TEXT;

-- AlterTable
ALTER TABLE "SupplierProduct" ADD COLUMN "apiShipClass" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "apiSku" TEXT;

-- CreateTable
CREATE TABLE "SupplierOrderPush" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "activeKey" TEXT,
    "supplierOrderCode" TEXT,
    "supplierInternalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "remoteStatus" TEXT,
    "totalCost" REAL,
    "shippingFee" REAL,
    "handleFee" REAL,
    "requestJson" TEXT NOT NULL,
    "responseJson" TEXT,
    "error" TEXT,
    "pushedById" TEXT,
    "pushedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" DATETIME,
    "lastSyncedAt" DATETIME,
    "exportMarked" BOOLEAN NOT NULL DEFAULT false,
    "prevExportJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupplierOrderPush_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierOrderPush_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOrderPush_externalOrderId_key" ON "SupplierOrderPush"("externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOrderPush_activeKey_key" ON "SupplierOrderPush"("activeKey");

-- CreateIndex
CREATE INDEX "SupplierOrderPush_orderId_supplierId_idx" ON "SupplierOrderPush"("orderId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierOrderPush_supplierOrderCode_idx" ON "SupplierOrderPush"("supplierOrderCode");

-- CreateIndex
CREATE UNIQUE INDEX "DesignArtwork_publicToken_key" ON "DesignArtwork"("publicToken");

