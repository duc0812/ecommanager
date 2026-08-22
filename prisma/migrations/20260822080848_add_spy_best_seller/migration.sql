-- CreateTable
CREATE TABLE "SpyBestSeller" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "prevRank" INTEGER,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpyBestSeller_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "SpyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyBestSeller_productId_fkey" FOREIGN KEY ("productId") REFERENCES "SpyProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpyBestSeller_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "SpyScan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SpyBestSeller_storeId_capturedAt_idx" ON "SpyBestSeller"("storeId", "capturedAt");

-- CreateIndex
CREATE INDEX "SpyBestSeller_productId_idx" ON "SpyBestSeller"("productId");

-- CreateIndex
CREATE INDEX "SpyBestSeller_scanId_idx" ON "SpyBestSeller"("scanId");
