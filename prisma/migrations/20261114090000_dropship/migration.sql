-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "dropship" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProductProfile" ADD COLUMN "dropship" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "OrderLine_dropship_idx" ON "OrderLine"("dropship");
