-- CreateTable
CREATE TABLE "ShopifyStoreCredential" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "authMode" TEXT NOT NULL,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "accessToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShopifyStoreCredential_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserStoreAccess" (
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "storeId"),
    CONSTRAINT "UserStoreAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserStoreAccess_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopifyStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" DATETIME,
    "currentBalance" REAL,
    "currentBalanceCurrency" TEXT,
    "syncSinceDate" DATETIME,
    "ianaTimezone" TEXT,
    "projectId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "orderPrefix" TEXT,
    "trackingPageUrl" TEXT,
    "payoutStartDate" TEXT,
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    CONSTRAINT "ShopifyStore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ShopifyStore" ("connectedAt", "currentBalance", "currentBalanceCurrency", "ianaTimezone", "id", "lastSyncAt", "projectId", "shop", "syncSinceDate") SELECT "connectedAt", "currentBalance", "currentBalanceCurrency", "ianaTimezone", "id", "lastSyncAt", "projectId", "shop", "syncSinceDate" FROM "ShopifyStore";
DROP TABLE "ShopifyStore";
ALTER TABLE "new_ShopifyStore" RENAME TO "ShopifyStore";
CREATE UNIQUE INDEX "ShopifyStore_shop_key" ON "ShopifyStore"("shop");
CREATE UNIQUE INDEX "ShopifyStore_projectId_key" ON "ShopifyStore"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- BACKFILL
-- Statements below are re-run by tests/multi-store-schema.integration.test.ts: keep each one idempotent and free of semicolons inside strings.
-- The old AppSetting rows are left in place so the migration can be rolled back.

INSERT INTO "ShopifyStoreCredential" ("storeId", "authMode", "clientId", "clientSecret", "accessToken", "connectedAt", "updatedAt")
SELECT s."id", 'OAUTH',
  (SELECT "value" FROM "AppSetting" WHERE "key" = 'shopify.app.apiKey'),
  (SELECT "value" FROM "AppSetting" WHERE "key" = 'shopify.app.apiSecret'),
  (SELECT "value" FROM "AppSetting" WHERE "key" = 'shopify.connection.token'),
  s."connectedAt", CURRENT_TIMESTAMP
FROM "ShopifyStore" s
WHERE s."shop" = (SELECT "value" FROM "AppSetting" WHERE "key" = 'shopify.connection.shop')
  AND (SELECT "value" FROM "AppSetting" WHERE "key" = 'shopify.connection.token') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "ShopifyStoreCredential" c WHERE c."storeId" = s."id");

UPDATE "ShopifyStore"
SET "orderPrefix" = 'LIT', "trackingPageUrl" = 'https://litzzy.com/apps/trackingorder?nums='
WHERE "shop" = 'caramiaus-store.myshopify.com' AND "orderPrefix" IS NULL;

UPDATE "ShopifyStore" SET "enabled" = false
WHERE "id" NOT IN (SELECT "storeId" FROM "ShopifyStoreCredential");

INSERT OR IGNORE INTO "UserStoreAccess" ("userId", "storeId")
SELECT u."id", s."id"
FROM "AppUser" u
JOIN "ShopifyStore" s ON s."shop" = 'caramiaus-store.myshopify.com'
WHERE u."role" = 'SELLER';
