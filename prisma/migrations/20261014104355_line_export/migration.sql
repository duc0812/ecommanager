-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "exportedAt" DATETIME;
ALTER TABLE "OrderLine" ADD COLUMN "exportedToSupplierId" TEXT;

-- CreateIndex
CREATE INDEX "OrderLine_exportedToSupplierId_idx" ON "OrderLine"("exportedToSupplierId");
