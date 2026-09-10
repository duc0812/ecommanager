-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SpyAd" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adArchiveId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "collationCount" INTEGER,
    "collationId" TEXT,
    "mediaType" TEXT,
    "displayFormat" TEXT,
    "ctaType" TEXT,
    "ctaText" TEXT,
    "linkUrl" TEXT,
    "resolvedUrl" TEXT,
    "linkResolvedAt" DATETIME,
    "mediaUrl" TEXT,
    "title" TEXT,
    "body" TEXT,
    "caption" TEXT,
    "publisherPlatforms" TEXT NOT NULL DEFAULT '[]',
    "currency" TEXT,
    "adLibraryUrl" TEXT,
    "rawPayload" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstCollationCount" INTEGER,
    "everActive" BOOLEAN NOT NULL DEFAULT false,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SpyAd_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "SpyAdvertiser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SpyAd" ("adArchiveId", "adLibraryUrl", "advertiserId", "body", "caption", "collationCount", "collationId", "ctaText", "ctaType", "currency", "displayFormat", "endDate", "firstSeenAt", "id", "isActive", "lastSeenAt", "linkResolvedAt", "linkUrl", "mediaType", "mediaUrl", "pageId", "publisherPlatforms", "rawPayload", "resolvedUrl", "startDate", "title") SELECT "adArchiveId", "adLibraryUrl", "advertiserId", "body", "caption", "collationCount", "collationId", "ctaText", "ctaType", "currency", "displayFormat", "endDate", "firstSeenAt", "id", "isActive", "lastSeenAt", "linkResolvedAt", "linkUrl", "mediaType", "mediaUrl", "pageId", "publisherPlatforms", "rawPayload", "resolvedUrl", "startDate", "title" FROM "SpyAd";
DROP TABLE "SpyAd";
ALTER TABLE "new_SpyAd" RENAME TO "SpyAd";
CREATE UNIQUE INDEX "SpyAd_adArchiveId_key" ON "SpyAd"("adArchiveId");
CREATE INDEX "SpyAd_advertiserId_idx" ON "SpyAd"("advertiserId");
CREATE INDEX "SpyAd_startDate_idx" ON "SpyAd"("startDate");
CREATE INDEX "SpyAd_isActive_idx" ON "SpyAd"("isActive");
CREATE INDEX "SpyAd_lastSeenAt_idx" ON "SpyAd"("lastSeenAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MetaBilling_adAccountId_status_billingDate_idx" ON "MetaBilling"("adAccountId", "status", "billingDate");

-- CreateIndex
CREATE INDEX "Order_storeId_placedAt_idx" ON "Order"("storeId", "placedAt");

-- CreateIndex
CREATE INDEX "Order_shopifyOrderNumber_idx" ON "Order"("shopifyOrderNumber");

-- CreateIndex
CREATE INDEX "Order_trelloCardId_idx" ON "Order"("trelloCardId");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_shopifyLineId_idx" ON "OrderLine"("orderId", "shopifyLineId");

-- CreateIndex
CREATE INDEX "Payout_storeId_status_date_idx" ON "Payout"("storeId", "status", "date");

-- CreateIndex
CREATE INDEX "PayoutTransaction_payoutId_idx" ON "PayoutTransaction"("payoutId");

-- CreateIndex
CREATE INDEX "StaffAssignment_projectId_idx" ON "StaffAssignment"("projectId");
