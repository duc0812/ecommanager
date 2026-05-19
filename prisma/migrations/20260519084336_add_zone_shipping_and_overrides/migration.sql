-- AlterTable
ALTER TABLE "Order" ADD COLUMN "shippingZone" TEXT;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "resolvedImportTax" REAL;
ALTER TABLE "OrderLine" ADD COLUMN "resolvedShipAdditional" REAL;
ALTER TABLE "OrderLine" ADD COLUMN "resolvedShipFirst" REAL;

-- AlterTable
ALTER TABLE "SupplierProduct" ADD COLUMN "baseSku" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "designTemplateUrl" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "maxProductionDays" INTEGER;
ALTER TABLE "SupplierProduct" ADD COLUMN "minProductionDays" INTEGER;
ALTER TABLE "SupplierProduct" ADD COLUMN "printingMethod" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "productType" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "shippingByRegion" TEXT;
ALTER TABLE "SupplierProduct" ADD COLUMN "sizeLabel" TEXT;

-- CreateTable
CREATE TABLE "SupplierZoneOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "zoneCode" TEXT NOT NULL,
    "countryCodes" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierZoneOverride_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierZoneOverride_supplierId_zoneCode_key" ON "SupplierZoneOverride"("supplierId", "zoneCode");

-- CreateIndex
CREATE INDEX "SupplierProduct_baseSku_idx" ON "SupplierProduct"("baseSku");
