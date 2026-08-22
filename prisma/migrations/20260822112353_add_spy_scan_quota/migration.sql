-- CreateTable
CREATE TABLE "SpyScanQuota" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "SpyScanQuota_userId_day_key" ON "SpyScanQuota"("userId", "day");
