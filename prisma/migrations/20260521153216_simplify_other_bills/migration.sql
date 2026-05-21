/*
  Warnings:

  - You are about to drop the column `accountingBasis` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `allocationNote` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `billDate` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `documentMimeType` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `documentName` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `documentSize` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `documentUrl` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `dueDate` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `expenseAccount` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceNumber` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `notes` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `paymentDate` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `paymentStatus` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `recognitionDate` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `referenceNumber` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `serviceEndDate` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `serviceStartDate` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `staffId` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `subtotalAmount` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `taxAmount` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `totalAmount` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `OtherBill` table. All the data in the column will be lost.
  - You are about to drop the column `vendorName` on the `OtherBill` table. All the data in the column will be lost.
  - Added the required column `amount` to the `OtherBill` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountUsd` to the `OtherBill` table without a default value. This is not possible if the table is not empty.
  - Added the required column `paidAt` to the `OtherBill` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vendor` to the `OtherBill` table without a default value. This is not possible if the table is not empty.
  - Made the column `paymentMethod` on table `OtherBill` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OtherBill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendor" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amountUsd" REAL NOT NULL,
    "exchangeRate" REAL,
    "paidAt" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "transactionId" TEXT,
    "note" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OtherBill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OtherBill" ("category", "createdAt", "currency", "id", "paymentMethod", "projectId") SELECT "category", "createdAt", "currency", "id", "paymentMethod", "projectId" FROM "OtherBill";
DROP TABLE "OtherBill";
ALTER TABLE "new_OtherBill" RENAME TO "OtherBill";
CREATE INDEX "OtherBill_paidAt_idx" ON "OtherBill"("paidAt");
CREATE INDEX "OtherBill_category_idx" ON "OtherBill"("category");
CREATE INDEX "OtherBill_projectId_idx" ON "OtherBill"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
