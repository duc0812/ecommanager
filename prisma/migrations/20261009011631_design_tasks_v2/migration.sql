-- AlterTable
ALTER TABLE "DesignArtwork" ADD COLUMN "heightPx" INTEGER;
ALTER TABLE "DesignArtwork" ADD COLUMN "widthPx" INTEGER;

-- CreateTable
CREATE TABLE "DesignTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "readiness" TEXT NOT NULL DEFAULT 'MANUAL',
    "assigneeId" TEXT,
    "kpi" REAL NOT NULL DEFAULT 0.3,
    "dueAt" DATETIME,
    "slaHours" INTEGER NOT NULL DEFAULT 24,
    "rejectReasons" TEXT,
    "rejectNote" TEXT,
    "prevStatus" TEXT,
    "supplierSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DesignTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DesignTaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DesignTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DesignTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PrintTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "name" TEXT NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "dpi" INTEGER NOT NULL DEFAULT 300,
    "bleedIn" REAL NOT NULL DEFAULT 0.125,
    "safeIn" REAL NOT NULL DEFAULT 0.2,
    "mirror" BOOLEAN NOT NULL DEFAULT false,
    "areas" TEXT NOT NULL,
    "guideImagePath" TEXT,
    "templateUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PrintTemplate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DesignTask_status_idx" ON "DesignTask"("status");

-- CreateIndex
CREATE INDEX "DesignTask_assigneeId_idx" ON "DesignTask"("assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignTask_orderId_shopifyLineId_key" ON "DesignTask"("orderId", "shopifyLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignTask_taskKey_key" ON "DesignTask"("taskKey");

-- CreateIndex
CREATE INDEX "DesignTaskEvent_taskId_idx" ON "DesignTaskEvent"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintTemplate_supplierId_supplierSku_key" ON "PrintTemplate"("supplierId", "supplierSku");
