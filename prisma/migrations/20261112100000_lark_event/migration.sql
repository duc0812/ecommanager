-- CreateTable
CREATE TABLE "LarkEvent" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "senderOpenId" TEXT NOT NULL,
    "senderName" TEXT,
    "text" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'RECEIVED',
    "jobIds" TEXT,
    "reply" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "LarkEvent_messageId_key" ON "LarkEvent"("messageId");

-- CreateIndex
CREATE INDEX "LarkEvent_createdAt_idx" ON "LarkEvent"("createdAt");

