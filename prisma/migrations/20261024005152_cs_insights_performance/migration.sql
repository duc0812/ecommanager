-- CreateTable
CREATE TABLE "CsReplyReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "issues" TEXT NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "rewrite" TEXT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    CONSTRAINT "CsReplyReview_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CsPerformanceReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CsAnalysis" (
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
    "rootCauseStage" TEXT,
    "rootCauseEvidence" TEXT,
    "rootCauseConfidence" TEXT,
    "issueType" TEXT,
    "affectedLineIds" TEXT NOT NULL DEFAULT '[]',
    "rootCauseAt" DATETIME,
    CONSTRAINT "CsAnalysis_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CsAnalysis" ("autoReplyEligible", "category", "citedCaseIds", "draftReply", "gateJson", "id", "inputHash", "model", "needsHuman", "outputJson", "proposal", "runAt", "sentiment", "summary", "ticketId", "tokensIn", "tokensOut", "urgency") SELECT "autoReplyEligible", "category", "citedCaseIds", "draftReply", "gateJson", "id", "inputHash", "model", "needsHuman", "outputJson", "proposal", "runAt", "sentiment", "summary", "ticketId", "tokensIn", "tokensOut", "urgency" FROM "CsAnalysis";
DROP TABLE "CsAnalysis";
ALTER TABLE "new_CsAnalysis" RENAME TO "CsAnalysis";
CREATE INDEX "CsAnalysis_ticketId_runAt_idx" ON "CsAnalysis"("ticketId", "runAt");
CREATE TABLE "new_CsMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "fdConversationId" TEXT,
    "author" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "fromEmail" TEXT,
    "sentiment" TEXT,
    "source" TEXT NOT NULL DEFAULT 'FRESHDESK',
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "CsMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CsMessage" ("author", "bodyHtml", "bodyText", "createdAt", "fdConversationId", "fromEmail", "id", "private", "ticketId") SELECT "author", "bodyHtml", "bodyText", "createdAt", "fdConversationId", "fromEmail", "id", "private", "ticketId" FROM "CsMessage";
DROP TABLE "CsMessage";
ALTER TABLE "new_CsMessage" RENAME TO "CsMessage";
CREATE UNIQUE INDEX "CsMessage_fdConversationId_key" ON "CsMessage"("fdConversationId");
CREATE INDEX "CsMessage_ticketId_createdAt_idx" ON "CsMessage"("ticketId", "createdAt");
CREATE TABLE "new_CsTicket" (
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
    "closedAt" DATETIME,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "fdFirstRespondedAt" DATETIME,
    "fdResolvedAt" DATETIME,
    "fdClosedAt" DATETIME,
    "fdReopenedAt" DATETIME,
    "rootCauseStageOverride" TEXT,
    "rootCauseNote" TEXT,
    "rootCauseById" TEXT,
    "reviewedAt" DATETIME,
    "reviewSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CsTicket" ("autoReplied", "category", "createdAt", "fdCreatedAt", "fdPriority", "fdStatus", "fdTags", "fdTicketId", "fdUpdatedAt", "id", "lastAnalysisAt", "lastCustomerAt", "lastNoteHash", "lastReplyAt", "needsHuman", "orderId", "orderMatch", "orderNumber", "requesterEmail", "requesterName", "resolvedInTool", "sentiment", "subject", "updatedAt", "urgency") SELECT "autoReplied", "category", "createdAt", "fdCreatedAt", "fdPriority", "fdStatus", "fdTags", "fdTicketId", "fdUpdatedAt", "id", "lastAnalysisAt", "lastCustomerAt", "lastNoteHash", "lastReplyAt", "needsHuman", "orderId", "orderMatch", "orderNumber", "requesterEmail", "requesterName", "resolvedInTool", "sentiment", "subject", "updatedAt", "urgency" FROM "CsTicket";
DROP TABLE "CsTicket";
ALTER TABLE "new_CsTicket" RENAME TO "CsTicket";
CREATE UNIQUE INDEX "CsTicket_fdTicketId_key" ON "CsTicket"("fdTicketId");
CREATE INDEX "CsTicket_needsHuman_urgency_lastCustomerAt_idx" ON "CsTicket"("needsHuman", "urgency", "lastCustomerAt");
CREATE INDEX "CsTicket_fdUpdatedAt_idx" ON "CsTicket"("fdUpdatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CsReplyReview_messageId_key" ON "CsReplyReview"("messageId");

-- CreateIndex
CREATE INDEX "CsReplyReview_ticketId_idx" ON "CsReplyReview"("ticketId");

-- CreateIndex
CREATE INDEX "CsPerformanceReport_periodStart_idx" ON "CsPerformanceReport"("periodStart");
