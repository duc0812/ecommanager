-- AlterTable
ALTER TABLE "MetaAdAccount" ADD COLUMN "balance" REAL;
ALTER TABLE "MetaAdAccount" ADD COLUMN "balanceCurrency" TEXT;
ALTER TABLE "MetaAdAccount" ADD COLUMN "balanceSyncedAt" DATETIME;

-- CreateTable
CREATE TABLE "CashflowSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "asOfDate" TEXT NOT NULL,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalPayout" REAL NOT NULL,
    "totalMetaBilling" REAL NOT NULL,
    "metaFxFee" REAL NOT NULL,
    "totalOrderCogs" REAL NOT NULL,
    "totalOtherCosts" REAL NOT NULL,
    "actualCashflow" REAL NOT NULL,
    "shopifyBalance" REAL NOT NULL,
    "inTransitPayout" REAL NOT NULL,
    "pendingPayout" REAL NOT NULL,
    "pendingInvoiceCharge" REAL NOT NULL,
    "projectedCashflow" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashflowSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CashflowSnapshot_projectId_idx" ON "CashflowSnapshot"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CashflowSnapshot_projectId_periodMonth_key" ON "CashflowSnapshot"("projectId", "periodMonth");
