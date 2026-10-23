-- AlterTable
ALTER TABLE "ArtworkEntry" ADD COLUMN "nasModifiedAt" DATETIME;
ALTER TABLE "ArtworkEntry" ADD COLUMN "nasPath" TEXT;
ALTER TABLE "ArtworkEntry" ADD COLUMN "nasSha256" TEXT;
ALTER TABLE "ArtworkEntry" ADD COLUMN "nasSize" INTEGER;
