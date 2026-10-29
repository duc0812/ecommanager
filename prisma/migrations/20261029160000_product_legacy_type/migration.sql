-- CreateTable
CREATE TABLE "ProductLegacyType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductLegacyType_storeId_shopifyProductId_key" ON "ProductLegacyType"("storeId", "shopifyProductId");

