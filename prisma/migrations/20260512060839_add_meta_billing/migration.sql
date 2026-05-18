-- CreateTable
CREATE TABLE "MetaAdAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT,
    "accessToken" TEXT NOT NULL,
    "currency" TEXT,
    "projectId" TEXT,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaAdAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MetaBilling" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adAccountId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "billingDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "chargeType" TEXT,
    "productType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaBilling_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdAccount_accountId_key" ON "MetaAdAccount"("accountId");
