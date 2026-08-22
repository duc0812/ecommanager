-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SpyPageTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT,
    "adDomainId" TEXT,
    "pageUrl" TEXT NOT NULL,
    "fbPageId" TEXT,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "lastScanAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyPageTarget_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SpyPageTarget_adDomainId_fkey" FOREIGN KEY ("adDomainId") REFERENCES "SpyAdDomain" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SpyPageTarget" ("active", "adDomainId", "createdAt", "fbPageId", "id", "label", "lastScanAt", "pageUrl", "storeId") SELECT "active", "adDomainId", "createdAt", "fbPageId", "id", "label", "lastScanAt", "pageUrl", "storeId" FROM "SpyPageTarget";
DROP TABLE "SpyPageTarget";
ALTER TABLE "new_SpyPageTarget" RENAME TO "SpyPageTarget";
CREATE UNIQUE INDEX "SpyPageTarget_pageUrl_key" ON "SpyPageTarget"("pageUrl");
CREATE INDEX "SpyPageTarget_storeId_idx" ON "SpyPageTarget"("storeId");
CREATE INDEX "SpyPageTarget_active_idx" ON "SpyPageTarget"("active");
CREATE INDEX "SpyPageTarget_adDomainId_idx" ON "SpyPageTarget"("adDomainId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
