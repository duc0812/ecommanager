-- AlterTable
ALTER TABLE "Order" ADD COLUMN "supplierHandoffAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "supplierHandoffById" TEXT;
ALTER TABLE "Order" ADD COLUMN "supplierHandoffMode" TEXT;

-- AlterTable
ALTER TABLE "SupplierProduct" ADD COLUMN "apiShipCountries" TEXT;
