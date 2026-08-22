-- CreateTable
CREATE TABLE "MetaExchangeRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "effectiveDate" TEXT NOT NULL,
    "rate" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaExchangeRate_effectiveDate_key" ON "MetaExchangeRate"("effectiveDate");
