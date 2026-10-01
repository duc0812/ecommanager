-- pendingPayout is gone: it estimated "order revenue not yet in balance", but the Shopify
-- balance and the in-transit payouts already hold that cash, so adding it double counted.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_CashflowSnapshot" (
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
    "shopifyBalance" REAL,
    "inTransitPayout" REAL,
    "pendingInvoiceCharge" REAL,
    "projectedCashflow" REAL,
    "expectedCashflow" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashflowSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- expectedCashflow was stored with the pendingPayout term in it; a backfill recomputes it.
INSERT INTO "new_CashflowSnapshot" ("id", "projectId", "periodMonth", "asOfDate", "takenAt", "totalPayout", "totalMetaBilling", "metaFxFee", "totalOrderCogs", "totalOtherCosts", "actualCashflow", "shopifyBalance", "inTransitPayout", "pendingInvoiceCharge", "projectedCashflow", "expectedCashflow", "createdAt", "updatedAt")
SELECT "id", "projectId", "periodMonth", "asOfDate", "takenAt", "totalPayout", "totalMetaBilling", "metaFxFee", "totalOrderCogs", "totalOtherCosts", "actualCashflow", "shopifyBalance", "inTransitPayout", "pendingInvoiceCharge", "projectedCashflow", NULL, "createdAt", "updatedAt"
FROM "CashflowSnapshot";

DROP TABLE "CashflowSnapshot";
ALTER TABLE "new_CashflowSnapshot" RENAME TO "CashflowSnapshot";

CREATE UNIQUE INDEX "CashflowSnapshot_projectId_periodMonth_key" ON "CashflowSnapshot"("projectId", "periodMonth");
CREATE INDEX "CashflowSnapshot_projectId_idx" ON "CashflowSnapshot"("projectId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
