-- CreateTable
CREATE TABLE "MetaCampaignDailySpend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adAccountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spend" REAL NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaCampaignDailySpend_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Niche" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MetaCampaignNicheOverride" (
    "campaignId" TEXT NOT NULL PRIMARY KEY,
    "nicheId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaCampaignNicheOverride_nicheId_fkey" FOREIGN KEY ("nicheId") REFERENCES "Niche" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MetaCampaignDailySpend_date_idx" ON "MetaCampaignDailySpend"("date");

-- CreateIndex
CREATE INDEX "MetaCampaignDailySpend_campaignId_idx" ON "MetaCampaignDailySpend"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCampaignDailySpend_adAccountId_campaignId_date_key" ON "MetaCampaignDailySpend"("adAccountId", "campaignId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Niche_name_key" ON "Niche"("name");
