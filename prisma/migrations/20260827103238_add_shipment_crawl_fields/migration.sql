-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN "checkpointsJson" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "crawlError" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "crawlSource" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "detectedCarrier" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "detectedCarrierCode" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "lastCheckpointAt" DATETIME;
