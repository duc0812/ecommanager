-- AlterTable
ALTER TABLE "AppUser" ADD COLUMN "skuPrefix" TEXT;

-- CreateTable
CREATE TABLE "CloneJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failKind" TEXT,
    "stage" TEXT,
    "platform" TEXT,
    "skuCode" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "productGid" TEXT,
    "handle" TEXT,
    "productUrl" TEXT,
    "productType" TEXT,
    "reused" BOOLEAN NOT NULL DEFAULT false,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "qaVerdict" TEXT,
    "qaNote" TEXT,
    "error" TEXT,
    "costUsd" REAL,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CloneJob_skuCode_key" ON "CloneJob"("skuCode");

-- CreateIndex
CREATE INDEX "CloneJob_status_createdAt_idx" ON "CloneJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CloneJob_storeId_sourceKey_idx" ON "CloneJob"("storeId", "sourceKey");

-- CreateIndex
CREATE INDEX "CloneJob_requestedById_createdAt_idx" ON "CloneJob"("requestedById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_skuPrefix_key" ON "AppUser"("skuPrefix");
