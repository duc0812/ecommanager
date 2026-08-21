-- CreateTable
CREATE TABLE "SpyPageTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT,
    "pageUrl" TEXT NOT NULL,
    "fbPageId" TEXT,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyPageTarget_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SpyPageTarget_pageUrl_key" ON "SpyPageTarget"("pageUrl");

-- CreateIndex
CREATE INDEX "SpyPageTarget_storeId_idx" ON "SpyPageTarget"("storeId");

-- CreateIndex
CREATE INDEX "SpyPageTarget_active_idx" ON "SpyPageTarget"("active");
