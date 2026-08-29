-- CreateTable
CREATE TABLE "OrderTaskState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "OrderTaskState_resolvedAt_idx" ON "OrderTaskState"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderTaskState_orderId_taskType_key" ON "OrderTaskState"("orderId", "taskType");
