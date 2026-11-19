-- CreateTable
CREATE TABLE "WorkBoardEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "worker" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "detail" TEXT,
    "version" INTEGER,
    "etaAt" DATETIME,
    "publishedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BotMappingChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskKey" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "comboJson" TEXT NOT NULL,
    "beforeOverridesJson" TEXT NOT NULL,
    "afterSupplierProductId" TEXT NOT NULL,
    "lineSnapshotJson" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" DATETIME
);

-- CreateIndex
CREATE INDEX "WorkBoardEntry_taskKey_idx" ON "WorkBoardEntry"("taskKey");

-- CreateIndex
CREATE INDEX "BotMappingChange_taskKey_createdAt_idx" ON "BotMappingChange"("taskKey", "createdAt");

