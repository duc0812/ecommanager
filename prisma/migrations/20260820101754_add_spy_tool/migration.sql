-- CreateTable
CREATE TABLE "SpyStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'shopify',
    "status" TEXT NOT NULL DEFAULT 'active',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SpyProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "handle" TEXT,
    "title" TEXT,
    "productType" TEXT,
    "vendor" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "imageUrl" TEXT,
    "priceMin" REAL,
    "priceMax" REAL,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "availableVariantCount" INTEGER NOT NULL DEFAULT 0,
    "niche" TEXT,
    "publishedAt" DATETIME,
    "dateSource" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyProduct_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpyProductSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "title" TEXT,
    "priceMin" REAL,
    "priceMax" REAL,
    "available" BOOLEAN,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyProductSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "SpyProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyProductSnapshot_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "SpyScan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpyAdvertiser" (
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
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyAdvertiser_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpyAd" (
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
    "title" TEXT,
    "body" TEXT,
    "caption" TEXT,
    "publisherPlatforms" TEXT NOT NULL DEFAULT '[]',
    "currency" TEXT,
    "adLibraryUrl" TEXT,
    "rawPayload" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyAd_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "SpyAdvertiser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpyAdObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "collationCount" INTEGER,
    "impressionsIndex" INTEGER,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyAdObservation_adId_fkey" FOREIGN KEY ("adId") REFERENCES "SpyAd" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyAdObservation_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "SpyScan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpyKeyword" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "term" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ALL',
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SpyKeywordHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keywordId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "rank" INTEGER,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyKeywordHit_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "SpyKeyword" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyKeywordHit_adId_fkey" FOREIGN KEY ("adId") REFERENCES "SpyAd" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyKeywordHit_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "SpyScan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpyScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "apifyRunId" TEXT,
    "apifyDatasetId" TEXT,
    "stats" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SpyIdea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "refType" TEXT NOT NULL DEFAULT 'NONE',
    "refAdId" TEXT,
    "refProductId" TEXT,
    "refStoreId" TEXT,
    "refKeywordId" TEXT,
    "snapshotJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SpyStore_domain_key" ON "SpyStore"("domain");

-- CreateIndex
CREATE INDEX "SpyStore_status_idx" ON "SpyStore"("status");

-- CreateIndex
CREATE INDEX "SpyProduct_firstSeenAt_idx" ON "SpyProduct"("firstSeenAt");

-- CreateIndex
CREATE INDEX "SpyProduct_productType_idx" ON "SpyProduct"("productType");

-- CreateIndex
CREATE INDEX "SpyProduct_storeId_idx" ON "SpyProduct"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "SpyProduct_storeId_externalProductId_key" ON "SpyProduct"("storeId", "externalProductId");

-- CreateIndex
CREATE INDEX "SpyProductSnapshot_productId_idx" ON "SpyProductSnapshot"("productId");

-- CreateIndex
CREATE INDEX "SpyProductSnapshot_scanId_idx" ON "SpyProductSnapshot"("scanId");

-- CreateIndex
CREATE UNIQUE INDEX "SpyAdvertiser_fbPageId_key" ON "SpyAdvertiser"("fbPageId");

-- CreateIndex
CREATE INDEX "SpyAdvertiser_storeId_idx" ON "SpyAdvertiser"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "SpyAd_adArchiveId_key" ON "SpyAd"("adArchiveId");

-- CreateIndex
CREATE INDEX "SpyAd_advertiserId_idx" ON "SpyAd"("advertiserId");

-- CreateIndex
CREATE INDEX "SpyAd_startDate_idx" ON "SpyAd"("startDate");

-- CreateIndex
CREATE INDEX "SpyAd_isActive_idx" ON "SpyAd"("isActive");

-- CreateIndex
CREATE INDEX "SpyAdObservation_adId_idx" ON "SpyAdObservation"("adId");

-- CreateIndex
CREATE INDEX "SpyAdObservation_scanId_idx" ON "SpyAdObservation"("scanId");

-- CreateIndex
CREATE UNIQUE INDEX "SpyAdObservation_adId_scanId_key" ON "SpyAdObservation"("adId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "SpyKeyword_term_country_key" ON "SpyKeyword"("term", "country");

-- CreateIndex
CREATE INDEX "SpyKeywordHit_keywordId_idx" ON "SpyKeywordHit"("keywordId");

-- CreateIndex
CREATE INDEX "SpyKeywordHit_adId_idx" ON "SpyKeywordHit"("adId");

-- CreateIndex
CREATE UNIQUE INDEX "SpyKeywordHit_keywordId_adId_scanId_key" ON "SpyKeywordHit"("keywordId", "adId", "scanId");

-- CreateIndex
CREATE INDEX "SpyScan_type_idx" ON "SpyScan"("type");

-- CreateIndex
CREATE INDEX "SpyScan_status_idx" ON "SpyScan"("status");

-- CreateIndex
CREATE INDEX "SpyScan_startedAt_idx" ON "SpyScan"("startedAt");

-- CreateIndex
CREATE INDEX "SpyIdea_status_idx" ON "SpyIdea"("status");

-- CreateIndex
CREATE INDEX "SpyIdea_refType_idx" ON "SpyIdea"("refType");
