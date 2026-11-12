-- CreateTable
CREATE TABLE "DesignAgentJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "taskId" TEXT,
    "taskKey" TEXT,
    "designCode" TEXT,
    "requestText" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedBy" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "summary" TEXT,
    "resultJson" TEXT,
    "libraryState" TEXT,
    "affectedJson" TEXT,
    "parentJobId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "DesignAgentJob_status_priority_createdAt_idx" ON "DesignAgentJob"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "DesignAgentJob_taskId_idx" ON "DesignAgentJob"("taskId");

