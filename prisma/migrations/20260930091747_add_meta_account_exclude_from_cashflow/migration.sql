-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MetaAdAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT,
    "accessToken" TEXT NOT NULL,
    "currency" TEXT,
    "projectId" TEXT,
    "lastSyncAt" DATETIME,
    "balance" REAL,
    "balanceCurrency" TEXT,
    "balanceSyncedAt" DATETIME,
    "accountStatus" INTEGER,
    "fundingCardLast4" TEXT,
    "fundingCardLabel" TEXT,
    "billingThreshold" REAL,
    "thresholdCurrency" TEXT,
    "thresholdSource" TEXT,
    "budgetRemaining" REAL,
    "plannedDailySpend" REAL,
    "spendToday" REAL,
    "activeCampaignCount" INTEGER,
    "excludedFromCashflow" BOOLEAN NOT NULL DEFAULT false,
    "budgetSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaAdAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MetaAdAccount" ("accessToken", "accountId", "accountName", "accountStatus", "activeCampaignCount", "balance", "balanceCurrency", "balanceSyncedAt", "billingThreshold", "budgetRemaining", "budgetSyncedAt", "createdAt", "currency", "fundingCardLabel", "fundingCardLast4", "id", "lastSyncAt", "plannedDailySpend", "projectId", "spendToday", "thresholdCurrency", "thresholdSource") SELECT "accessToken", "accountId", "accountName", "accountStatus", "activeCampaignCount", "balance", "balanceCurrency", "balanceSyncedAt", "billingThreshold", "budgetRemaining", "budgetSyncedAt", "createdAt", "currency", "fundingCardLabel", "fundingCardLast4", "id", "lastSyncAt", "plannedDailySpend", "projectId", "spendToday", "thresholdCurrency", "thresholdSource" FROM "MetaAdAccount";
DROP TABLE "MetaAdAccount";
ALTER TABLE "new_MetaAdAccount" RENAME TO "MetaAdAccount";
CREATE UNIQUE INDEX "MetaAdAccount_accountId_key" ON "MetaAdAccount"("accountId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
