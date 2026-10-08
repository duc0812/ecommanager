-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN "customAttributesJson" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "designNote" TEXT;

-- CreateTable
CREATE TABLE "DesignArtwork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderLineId" TEXT NOT NULL,
    "printArea" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DesignArtwork_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DesignArtwork_orderLineId_idx" ON "DesignArtwork"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignArtwork_orderLineId_printArea_version_key" ON "DesignArtwork"("orderLineId", "printArea", "version");
