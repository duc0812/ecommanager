CREATE TABLE "FulfillmentCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerName" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "billDate" TEXT NOT NULL,
    "serviceStartDate" TEXT,
    "serviceEndDate" TEXT,
    "recognitionDate" TEXT NOT NULL,
    "costType" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "productCost" REAL NOT NULL DEFAULT 0,
    "pickPackCost" REAL NOT NULL DEFAULT 0,
    "shippingCost" REAL NOT NULL DEFAULT 0,
    "storageCost" REAL NOT NULL DEFAULT 0,
    "returnCost" REAL NOT NULL DEFAULT 0,
    "adjustmentAmount" REAL NOT NULL DEFAULT 0,
    "taxAmount" REAL NOT NULL DEFAULT 0,
    "totalAmount" REAL NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paymentDate" TEXT,
    "paymentMethod" TEXT,
    "referenceNumber" TEXT,
    "projectId" TEXT,
    "staffId" TEXT,
    "documentUrl" TEXT,
    "documentName" TEXT,
    "documentMimeType" TEXT,
    "documentSize" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FulfillmentCost_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FulfillmentCost_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FulfillmentCost_billDate_idx" ON "FulfillmentCost"("billDate");
CREATE INDEX "FulfillmentCost_recognitionDate_idx" ON "FulfillmentCost"("recognitionDate");
CREATE INDEX "FulfillmentCost_costType_idx" ON "FulfillmentCost"("costType");
CREATE INDEX "FulfillmentCost_paymentStatus_idx" ON "FulfillmentCost"("paymentStatus");
CREATE INDEX "FulfillmentCost_projectId_idx" ON "FulfillmentCost"("projectId");
CREATE INDEX "FulfillmentCost_staffId_idx" ON "FulfillmentCost"("staffId");
