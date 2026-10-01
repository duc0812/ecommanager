-- Drops pendingPayout (the metric is gone) and makes the three "as of now" figures nullable,
-- so a snapshot taken outside its own period records "unknown" rather than today's numbers.
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashflowSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_CashflowSnapshot" ("id", "projectId", "periodMonth", "asOfDate", "takenAt", "totalPayout", "totalMetaBilling", "metaFxFee", "totalOrderCogs", "totalOtherCosts", "actualCashflow", "shopifyBalance", "inTransitPayout", "pendingInvoiceCharge", "projectedCashflow", "createdAt", "updatedAt")
SELECT "id", "projectId", "periodMonth", "asOfDate", "takenAt", "totalPayout", "totalMetaBilling", "metaFxFee", "totalOrderCogs", "totalOtherCosts", "actualCashflow", "shopifyBalance", "inTransitPayout", "pendingInvoiceCharge", "projectedCashflow", "createdAt", "updatedAt"
FROM "CashflowSnapshot";

DROP TABLE "CashflowSnapshot";
ALTER TABLE "new_CashflowSnapshot" RENAME TO "CashflowSnapshot";

CREATE UNIQUE INDEX "CashflowSnapshot_projectId_periodMonth_key" ON "CashflowSnapshot"("projectId", "periodMonth");
CREATE INDEX "CashflowSnapshot_projectId_idx" ON "CashflowSnapshot"("projectId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- A snapshot written long after its period closed carries the balance of the day it ran, not of
-- the period end (the 2026-09-13 backfill stamped one day's figures onto seven months). Unknown.
UPDATE "CashflowSnapshot"
SET "shopifyBalance" = NULL, "inTransitPayout" = NULL, "pendingInvoiceCharge" = NULL, "projectedCashflow" = NULL
WHERE julianday(substr("takenAt", 1, 10)) - julianday("asOfDate") > 2;
