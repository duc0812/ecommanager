-- AlterTable
ALTER TABLE "DesignArtwork" ADD COLUMN "outsourceId" TEXT;
ALTER TABLE "DesignArtwork" ADD COLUMN "outsourceRevision" INTEGER;
ALTER TABLE "DesignArtwork" ADD COLUMN "outsourceTemplateVersion" TEXT;

-- CreateTable
CREATE TABLE "DesignOutsource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "brief" TEXT NOT NULL,
    "templateLabel" TEXT NOT NULL,
    "templateUrl" TEXT NOT NULL,
    "templateSnapshot" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "confirmedTemplateVersion" TEXT,
    "referenceUrl" TEXT,
    "personalization" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DesignOutsource_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DesignTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DesignOutsourceMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outsourceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DesignOutsourceMessage_outsourceId_fkey" FOREIGN KEY ("outsourceId") REFERENCES "DesignOutsource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DesignOutsource_code_key" ON "DesignOutsource"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DesignOutsource_taskId_key" ON "DesignOutsource"("taskId");

-- CreateIndex
CREATE INDEX "DesignOutsource_assigneeId_active_idx" ON "DesignOutsource"("assigneeId", "active");

-- CreateIndex
CREATE INDEX "DesignOutsourceMessage_outsourceId_revision_idx" ON "DesignOutsourceMessage"("outsourceId", "revision");

-- CreateIndex
CREATE INDEX "DesignArtwork_outsourceId_outsourceRevision_idx" ON "DesignArtwork"("outsourceId", "outsourceRevision");
