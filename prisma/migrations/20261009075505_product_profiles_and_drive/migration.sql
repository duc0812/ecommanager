-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "shopifyProductId" TEXT;

-- CreateTable
CREATE TABLE "DesignArtworkUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "printArea" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sessionUrl" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "driveFileId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "DesignArtworkUpload_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "supplierProductId" TEXT,
    "overrides" TEXT NOT NULL DEFAULT '[]',
    "printTemplateId" TEXT,
    "masterArtworkUrl" TEXT,
    "masterArtworkId" TEXT,
    "layerMap" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductProfile_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProductProfile_printTemplateId_fkey" FOREIGN KEY ("printTemplateId") REFERENCES "PrintTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DesignArtwork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "printArea" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT,
    "storage" TEXT NOT NULL DEFAULT 'LOCAL',
    "driveFileId" TEXT,
    "driveWebViewLink" TEXT,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DesignArtwork_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DesignArtwork" ("createdAt", "fileName", "heightPx", "id", "mimeType", "orderId", "printArea", "shopifyLineId", "size", "storagePath", "uploadedById", "version", "widthPx") SELECT "createdAt", "fileName", "heightPx", "id", "mimeType", "orderId", "printArea", "shopifyLineId", "size", "storagePath", "uploadedById", "version", "widthPx" FROM "DesignArtwork";
DROP TABLE "DesignArtwork";
ALTER TABLE "new_DesignArtwork" RENAME TO "DesignArtwork";
CREATE INDEX "DesignArtwork_orderId_idx" ON "DesignArtwork"("orderId");
CREATE UNIQUE INDEX "DesignArtwork_orderId_shopifyLineId_printArea_version_key" ON "DesignArtwork"("orderId", "shopifyLineId", "printArea", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DesignArtworkUpload_orderId_idx" ON "DesignArtworkUpload"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductProfile_storeId_shopifyProductId_key" ON "ProductProfile"("storeId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "OrderLine_shopifyProductId_idx" ON "OrderLine"("shopifyProductId");
