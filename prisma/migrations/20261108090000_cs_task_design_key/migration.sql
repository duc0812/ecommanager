-- AlterTable
ALTER TABLE "CsTask" ADD COLUMN "designTaskKey" TEXT;

-- CreateIndex
CREATE INDEX "CsTask_designTaskKey_idx" ON "CsTask"("designTaskKey");

