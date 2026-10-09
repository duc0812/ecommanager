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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtworkEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_printTemplateId_fkey" FOREIGN KEY ("printTemplateId") REFERENCES "PrintTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_psdFileId_fkey" FOREIGN KEY ("psdFileId") REFERENCES "LibraryFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_artworkFileId_fkey" FOREIGN KEY ("artworkFileId") REFERENCES "LibraryFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ArtworkEntry_previewFileId_fkey" FOREIGN KEY ("previewFileId") REFERENCES "LibraryFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ArtworkEntry" ("approvedAt", "approvedById", "artworkFileId", "checkScore", "createdAt", "error", "fields", "fixedTexts", "id", "imageUrl", "missingFonts", "notes", "parsedAt", "previewFileId", "printTemplateId", "psdFileId", "shopifyProductId", "status", "storeId", "supplierId", "title", "updatedAt", "warnings") SELECT "approvedAt", "approvedById", "artworkFileId", "checkScore", "createdAt", "error", "fields", "fixedTexts", "id", "imageUrl", "missingFonts", "notes", "parsedAt", "previewFileId", "printTemplateId", "psdFileId", "shopifyProductId", "status", "storeId", "supplierId", "title", "updatedAt", "warnings" FROM "ArtworkEntry";
DROP TABLE "ArtworkEntry";
ALTER TABLE "new_ArtworkEntry" RENAME TO "ArtworkEntry";
CREATE INDEX "ArtworkEntry_status_idx" ON "ArtworkEntry"("status");
CREATE INDEX "ArtworkEntry_printTemplateId_idx" ON "ArtworkEntry"("printTemplateId");
CREATE UNIQUE INDEX "ArtworkEntry_storeId_shopifyProductId_printTemplateId_optionKey_key" ON "ArtworkEntry"("storeId", "shopifyProductId", "printTemplateId", "optionKey");
CREATE TABLE "new_ProductProfile" (
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
    "artworkSplits" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductProfile_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProductProfile_printTemplateId_fkey" FOREIGN KEY ("printTemplateId") REFERENCES "PrintTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProductProfile" ("createdAt", "id", "imageUrl", "layerMap", "masterArtworkId", "masterArtworkUrl", "notes", "overrides", "printTemplateId", "shopifyProductId", "storeId", "supplierProductId", "title", "updatedAt") SELECT "createdAt", "id", "imageUrl", "layerMap", "masterArtworkId", "masterArtworkUrl", "notes", "overrides", "printTemplateId", "shopifyProductId", "storeId", "supplierProductId", "title", "updatedAt" FROM "ProductProfile";
DROP TABLE "ProductProfile";
ALTER TABLE "new_ProductProfile" RENAME TO "ProductProfile";
CREATE UNIQUE INDEX "ProductProfile_storeId_shopifyProductId_key" ON "ProductProfile"("storeId", "shopifyProductId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
