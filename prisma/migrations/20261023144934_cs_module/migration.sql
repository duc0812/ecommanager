-- CreateTable
CREATE TABLE "CsTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fdTicketId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "fdStatus" INTEGER NOT NULL,
    "fdPriority" INTEGER NOT NULL,
    "fdTags" TEXT NOT NULL DEFAULT '[]',
    "requesterEmail" TEXT,
    "requesterName" TEXT,
    "orderId" TEXT,
    "orderNumber" TEXT,
    "orderMatch" TEXT NOT NULL DEFAULT 'NONE',
    "category" TEXT,
    "urgency" TEXT,
    "sentiment" TEXT,
    "needsHuman" BOOLEAN NOT NULL DEFAULT true,
    "autoReplied" BOOLEAN NOT NULL DEFAULT false,
    "resolvedInTool" BOOLEAN NOT NULL DEFAULT false,
    "fdCreatedAt" DATETIME NOT NULL,
    "fdUpdatedAt" DATETIME NOT NULL,
    "lastCustomerAt" DATETIME,
    "lastReplyAt" DATETIME,
    "lastAnalysisAt" DATETIME,
    "lastNoteHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CsMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "fdConversationId" TEXT,
    "author" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "fromEmail" TEXT,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "CsMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CsAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "proposal" TEXT NOT NULL,
    "draftReply" TEXT,
    "needsHuman" BOOLEAN NOT NULL,
    "citedCaseIds" TEXT NOT NULL DEFAULT '[]',
    "autoReplyEligible" BOOLEAN NOT NULL DEFAULT false,
    "gateJson" TEXT NOT NULL DEFAULT '{}',
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CsAnalysis_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CsCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "situation" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "toneNotes" TEXT,
    "forbidden" TEXT,
    "exampleReply" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "promotedFromTicketId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CsAgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "ticketsSeen" INTEGER NOT NULL DEFAULT 0,
    "analysed" INTEGER NOT NULL DEFAULT 0,
    "autoReplied" INTEGER NOT NULL DEFAULT 0,
    "fdRequests" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "CsTicket_fdTicketId_key" ON "CsTicket"("fdTicketId");

-- CreateIndex
CREATE INDEX "CsTicket_needsHuman_urgency_lastCustomerAt_idx" ON "CsTicket"("needsHuman", "urgency", "lastCustomerAt");

-- CreateIndex
CREATE INDEX "CsTicket_fdUpdatedAt_idx" ON "CsTicket"("fdUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CsMessage_fdConversationId_key" ON "CsMessage"("fdConversationId");

-- CreateIndex
CREATE INDEX "CsMessage_ticketId_createdAt_idx" ON "CsMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "CsAnalysis_ticketId_runAt_idx" ON "CsAnalysis"("ticketId", "runAt");

-- CreateIndex
CREATE INDEX "CsCase_category_active_idx" ON "CsCase"("category", "active");
