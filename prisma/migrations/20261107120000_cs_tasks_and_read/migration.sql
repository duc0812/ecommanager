-- AlterTable
ALTER TABLE "CsTicket" ADD COLUMN "lastAgentAt" DATETIME;
ALTER TABLE "CsTicket" ADD COLUMN "staffReadAt" DATETIME;
ALTER TABLE "CsTicket" ADD COLUMN "staffReadById" TEXT;
ALTER TABLE "CsTicket" ADD COLUMN "staffReadByName" TEXT;

-- CreateTable
CREATE TABLE "CsTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT,
    "orderNumber" TEXT,
    "type" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "detail" TEXT NOT NULL,
    "amount" REAL,
    "source" TEXT NOT NULL DEFAULT 'AGENT',
    "createdById" TEXT,
    "createdByName" TEXT,
    "dueAt" DATETIME,
    "doneAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CsTask_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CsTaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "authorId" TEXT,
    "authorName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CsTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CsTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CsTask_status_priority_idx" ON "CsTask"("status", "priority");

-- CreateIndex
CREATE INDEX "CsTask_ticketId_idx" ON "CsTask"("ticketId");

-- CreateIndex
CREATE INDEX "CsTaskEvent_taskId_createdAt_idx" ON "CsTaskEvent"("taskId", "createdAt");


-- Backfill: when the agent last emailed the customer on each ticket
UPDATE "CsTicket" SET "lastAgentAt" = (SELECT max("createdAt") FROM "CsMessage" WHERE "CsMessage"."ticketId" = "CsTicket"."id" AND "author" = 'AGENT' AND "private" = 0);
