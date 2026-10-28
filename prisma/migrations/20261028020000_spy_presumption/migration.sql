-- CreateTable
CREATE TABLE "SpyPresumption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "rules" TEXT NOT NULL DEFAULT '[]',
    "firstFlaggedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "levelSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyPresumption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "SpyProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyPresumption_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SpyPresumption_productId_key" ON "SpyPresumption"("productId");

-- CreateIndex
CREATE INDEX "SpyPresumption_level_idx" ON "SpyPresumption"("level");

-- CreateIndex
CREATE INDEX "SpyPresumption_storeId_idx" ON "SpyPresumption"("storeId");

