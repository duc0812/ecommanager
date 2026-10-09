-- CreateTable
CREATE TABLE "LibraryFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage" TEXT NOT NULL DEFAULT 'LOCAL',
    "storagePath" TEXT,
    "driveFileId" TEXT,
    "driveWebViewLink" TEXT,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ArtworkEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "printTemplateId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "DesignFont" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postscriptName" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DesignFont_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "LibraryFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArtworkJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'PARSE_PSD',
    "entryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ArtworkJob_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ArtworkEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LibraryFile_kind_sha256_idx" ON "LibraryFile"("kind", "sha256");

-- CreateIndex
CREATE INDEX "ArtworkEntry_status_idx" ON "ArtworkEntry"("status");

-- CreateIndex
CREATE INDEX "ArtworkEntry_printTemplateId_idx" ON "ArtworkEntry"("printTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtworkEntry_storeId_shopifyProductId_printTemplateId_key" ON "ArtworkEntry"("storeId", "shopifyProductId", "printTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignFont_postscriptName_key" ON "DesignFont"("postscriptName");

-- CreateIndex
CREATE INDEX "ArtworkJob_status_createdAt_idx" ON "ArtworkJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ArtworkJob_entryId_idx" ON "ArtworkJob"("entryId");
