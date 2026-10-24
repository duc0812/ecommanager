-- CreateTable
CREATE TABLE "CreativeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL DEFAULT '{}',
    "refImages" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "providerTaskId" TEXT,
    "resultFiles" TEXT NOT NULL DEFAULT '[]',
    "resultUrls" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "cost" TEXT,
    "durationMs" INTEGER,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "CreativeJob_createdAt_idx" ON "CreativeJob"("createdAt");

