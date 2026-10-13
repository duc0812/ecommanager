-- AlterTable
ALTER TABLE "DesignTask" ADD COLUMN "driveFolderId" TEXT;
ALTER TABLE "DesignTask" ADD COLUMN "driveFolderUrl" TEXT;

-- AlterTable
ALTER TABLE "DesignArtwork" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PRINT';
ALTER TABLE "DesignArtwork" ADD COLUMN "drivePlace" TEXT;

-- AlterTable
ALTER TABLE "DesignArtworkUpload" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PRINT';

-- Every existing row is a PRINT file, so rows unique on (order, line, part, version) stay unique once kind joins the key.
-- DropIndex
DROP INDEX "DesignArtwork_orderId_shopifyLineId_printArea_version_key";

-- CreateIndex
CREATE UNIQUE INDEX "DesignArtwork_orderId_shopifyLineId_kind_printArea_version_key" ON "DesignArtwork"("orderId", "shopifyLineId", "kind", "printArea", "version");
