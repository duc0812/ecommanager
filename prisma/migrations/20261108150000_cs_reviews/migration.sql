-- AlterTable
ALTER TABLE "CsTask" ADD COLUMN "reviewId" TEXT;

-- CreateTable
CREATE TABLE "CsReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "judgemeId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "productExternalId" TEXT,
    "productTitle" TEXT,
    "reviewerEmail" TEXT,
    "reviewerName" TEXT,
    "verified" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "reviewCreatedAt" DATETIME NOT NULL,
    "orderNumber" TEXT,
    "matchNote" TEXT,
    "caseType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "draftSubject" TEXT,
    "draftBody" TEXT,
    "fdTicketId" INTEGER,
    "sentAt" DATETIME,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CsReview_judgemeId_key" ON "CsReview"("judgemeId");

-- CreateIndex
CREATE INDEX "CsReview_status_idx" ON "CsReview"("status");

