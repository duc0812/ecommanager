-- CreateTable
CREATE TABLE "CsDirective" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedById" TEXT,
    "fdNoteId" TEXT,
    CONSTRAINT "CsDirective_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "CsTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CsDirective_ticketId_resolvedAt_idx" ON "CsDirective"("ticketId", "resolvedAt");
