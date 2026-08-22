-- CreateTable
CREATE TABLE "SpyAdDomain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "searchTerm" TEXT NOT NULL,
    "label" TEXT,
    "country" TEXT NOT NULL DEFAULT 'ALL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SpyAdvertiser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fbPageId" TEXT NOT NULL,
    "pageName" TEXT,
    "pageCategory" TEXT,
    "pageProfileUri" TEXT,
    "likes" INTEGER,
    "igUsername" TEXT,
    "igFollowers" INTEGER,
    "entityType" TEXT,
    "storeId" TEXT,
    "adDomainId" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyAdvertiser_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SpyAdvertiser_adDomainId_fkey" FOREIGN KEY ("adDomainId") REFERENCES "SpyAdDomain" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SpyAdvertiser" ("entityType", "fbPageId", "firstSeenAt", "id", "igFollowers", "igUsername", "lastSeenAt", "likes", "pageCategory", "pageName", "pageProfileUri", "storeId") SELECT "entityType", "fbPageId", "firstSeenAt", "id", "igFollowers", "igUsername", "lastSeenAt", "likes", "pageCategory", "pageName", "pageProfileUri", "storeId" FROM "SpyAdvertiser";
DROP TABLE "SpyAdvertiser";
ALTER TABLE "new_SpyAdvertiser" RENAME TO "SpyAdvertiser";
CREATE UNIQUE INDEX "SpyAdvertiser_fbPageId_key" ON "SpyAdvertiser"("fbPageId");
CREATE INDEX "SpyAdvertiser_storeId_idx" ON "SpyAdvertiser"("storeId");
CREATE INDEX "SpyAdvertiser_adDomainId_idx" ON "SpyAdvertiser"("adDomainId");
CREATE TABLE "new_SpyPageTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT,
    "adDomainId" TEXT,
    "pageUrl" TEXT NOT NULL,
    "fbPageId" TEXT,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyPageTarget_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SpyPageTarget_adDomainId_fkey" FOREIGN KEY ("adDomainId") REFERENCES "SpyAdDomain" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SpyPageTarget" ("active", "createdAt", "fbPageId", "id", "label", "lastScanAt", "pageUrl", "storeId") SELECT "active", "createdAt", "fbPageId", "id", "label", "lastScanAt", "pageUrl", "storeId" FROM "SpyPageTarget";
DROP TABLE "SpyPageTarget";
ALTER TABLE "new_SpyPageTarget" RENAME TO "SpyPageTarget";
CREATE UNIQUE INDEX "SpyPageTarget_pageUrl_key" ON "SpyPageTarget"("pageUrl");
CREATE INDEX "SpyPageTarget_storeId_idx" ON "SpyPageTarget"("storeId");
CREATE INDEX "SpyPageTarget_active_idx" ON "SpyPageTarget"("active");
CREATE INDEX "SpyPageTarget_adDomainId_idx" ON "SpyPageTarget"("adDomainId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SpyAdDomain_domain_key" ON "SpyAdDomain"("domain");

-- CreateIndex
CREATE INDEX "SpyAdDomain_active_idx" ON "SpyAdDomain"("active");
