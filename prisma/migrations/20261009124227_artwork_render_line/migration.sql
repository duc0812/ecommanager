-- AlterTable
ALTER TABLE "ArtworkJob" ADD COLUMN "orderId" TEXT;
ALTER TABLE "ArtworkJob" ADD COLUMN "printArea" TEXT;
ALTER TABLE "ArtworkJob" ADD COLUMN "resultArtworkId" TEXT;
ALTER TABLE "ArtworkJob" ADD COLUMN "shopifyLineId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ArtworkEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "printTemplateId" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL DEFAULT '',
    "supplierId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EMPTY',
    "psdFileId" TEXT,
    "artworkFileId" TEXT,
    "previewFileId" TEXT,
    "fields" TEXT NOT NULL DEFAULT '[]',
    "fixedTexts" TEXT NOT NULL DEFAULT '[]',
    "missingFonts" TEXT NOT NULL DEFAULT '[]',
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "checkScore" REAL,
    "error" TEXT,
    "parsedAt" DATETIME,
    "approvedAt" DATETIME,
    "approvedById" TEXT,
    "notes" TEXT,
    "layerFields" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtworkEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_printTemplateId_fkey" FOREIGN KEY ("printTemplateId") REFERENCES "PrintTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_psdFileId_fkey" FOREIGN KEY ("psdFileId") REFERENCES "LibraryFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_artworkFileId_fkey" FOREIGN KEY ("artworkFileId") REFERENCES "LibraryFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_previewFileId_fkey" FOREIGN KEY ("previewFileId") REFERENCES "LibraryFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ArtworkEntry" ("approvedAt", "approvedById", "artworkFileId", "checkScore", "createdAt", "error", "fields", "fixedTexts", "id", "imageUrl", "missingFonts", "notes", "optionKey", "parsedAt", "previewFileId", "printTemplateId", "psdFileId", "shopifyProductId", "status", "storeId", "supplierId", "title", "updatedAt", "warnings") SELECT "approvedAt", "approvedById", "artworkFileId", "checkScore", "createdAt", "error", "fields", "fixedTexts", "id", "imageUrl", "missingFonts", "notes", "optionKey", "parsedAt", "previewFileId", "printTemplateId", "psdFileId", "shopifyProductId", "status", "storeId", "supplierId", "title", "updatedAt", "warnings" FROM "ArtworkEntry";
DROP TABLE "ArtworkEntry";
ALTER TABLE "new_ArtworkEntry" RENAME TO "ArtworkEntry";
CREATE INDEX "ArtworkEntry_status_idx" ON "ArtworkEntry"("status");
CREATE INDEX "ArtworkEntry_printTemplateId_idx" ON "ArtworkEntry"("printTemplateId");
CREATE UNIQUE INDEX "ArtworkEntry_storeId_shopifyProductId_printTemplateId_optionKey_key" ON "ArtworkEntry"("storeId", "shopifyProductId", "printTemplateId", "optionKey");
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
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "previewPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    "removedById" TEXT,
    CONSTRAINT "DesignArtwork_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DesignArtwork" ("createdAt", "driveFileId", "driveWebViewLink", "fileName", "heightPx", "id", "mimeType", "orderId", "printArea", "removedAt", "removedById", "shopifyLineId", "size", "storage", "storagePath", "uploadedById", "version", "widthPx") SELECT "createdAt", "driveFileId", "driveWebViewLink", "fileName", "heightPx", "id", "mimeType", "orderId", "printArea", "removedAt", "removedById", "shopifyLineId", "size", "storage", "storagePath", "uploadedById", "version", "widthPx" FROM "DesignArtwork";
DROP TABLE "DesignArtwork";
ALTER TABLE "new_DesignArtwork" RENAME TO "DesignArtwork";
CREATE INDEX "DesignArtwork_orderId_idx" ON "DesignArtwork"("orderId");
CREATE UNIQUE INDEX "DesignArtwork_orderId_shopifyLineId_printArea_version_key" ON "DesignArtwork"("orderId", "shopifyLineId", "printArea", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ArtworkJob_orderId_shopifyLineId_idx" ON "ArtworkJob"("orderId", "shopifyLineId");
