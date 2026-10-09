-- DesignArtwork is re-keyed from OrderLine.id (recreated on every Shopify sync) to (orderId, shopifyLineId).
-- No production uploads exist yet, so the table is dropped and recreated.
DROP TABLE "DesignArtwork";

-- CreateTable
CREATE TABLE "DesignArtwork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "printArea" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DesignArtwork_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DesignArtwork_orderId_idx" ON "DesignArtwork"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignArtwork_orderId_shopifyLineId_printArea_version_key" ON "DesignArtwork"("orderId", "shopifyLineId", "printArea", "version");
