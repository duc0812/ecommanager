-- AlterTable
ALTER TABLE "ScaleJob" ADD COLUMN "viewsJson" TEXT NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "ScaleTargetView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'front',
    "blankFile" TEXT,
    "blankDescription" TEXT NOT NULL DEFAULT '',
    "unprintedParts" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ScaleTargetView_targetId_idx" ON "ScaleTargetView"("targetId");
