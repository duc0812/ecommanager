-- CreateTable
CREATE TABLE "ShopifyStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" DATETIME
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "chargesFeeAmount" REAL NOT NULL DEFAULT 0,
    "chargesGrossAmount" REAL NOT NULL DEFAULT 0,
    "refundsFeeAmount" REAL NOT NULL DEFAULT 0,
    "refundsGrossAmount" REAL NOT NULL DEFAULT 0,
    "adjustmentsFeeAmount" REAL NOT NULL DEFAULT 0,
    "adjustmentsGrossAmount" REAL NOT NULL DEFAULT 0,
    "bankAccountShopifyId" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payout_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PayoutTransaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "payoutId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "fee" REAL NOT NULL,
    "net" REAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceOrderId" INTEGER,
    "processedAt" DATETIME NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayoutTransaction_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_shop_key" ON "ShopifyStore"("shop");
