-- AlterTable
ALTER TABLE "MetaAdAccount" ADD COLUMN "accountStatus" INTEGER;
ALTER TABLE "MetaAdAccount" ADD COLUMN "activeCampaignCount" INTEGER;
ALTER TABLE "MetaAdAccount" ADD COLUMN "billingThreshold" REAL;
ALTER TABLE "MetaAdAccount" ADD COLUMN "budgetRemaining" REAL;
ALTER TABLE "MetaAdAccount" ADD COLUMN "budgetSyncedAt" DATETIME;
ALTER TABLE "MetaAdAccount" ADD COLUMN "fundingCardLabel" TEXT;
ALTER TABLE "MetaAdAccount" ADD COLUMN "fundingCardLast4" TEXT;
ALTER TABLE "MetaAdAccount" ADD COLUMN "plannedDailySpend" REAL;
ALTER TABLE "MetaAdAccount" ADD COLUMN "thresholdCurrency" TEXT;
ALTER TABLE "MetaAdAccount" ADD COLUMN "thresholdSource" TEXT;
