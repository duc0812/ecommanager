CREATE TABLE "OtherBill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendorName" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "billDate" TEXT NOT NULL,
    "dueDate" TEXT,
    "serviceStartDate" TEXT,
    "serviceEndDate" TEXT,
    "category" TEXT NOT NULL,
    "expenseAccount" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotalAmount" REAL NOT NULL,
    "taxAmount" REAL NOT NULL DEFAULT 0,
    "totalAmount" REAL NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paymentDate" TEXT,
    "paymentMethod" TEXT,
    "referenceNumber" TEXT,
    "projectId" TEXT,
    "staffId" TEXT,
    "allocationNote" TEXT,
    "documentUrl" TEXT,
    "documentName" TEXT,
    "documentMimeType" TEXT,
    "documentSize" INTEGER,
    "accountingBasis" TEXT NOT NULL DEFAULT 'ACCRUAL',
    "recognitionDate" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OtherBill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OtherBill_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "OtherBill_billDate_idx" ON "OtherBill"("billDate");
CREATE INDEX "OtherBill_recognitionDate_idx" ON "OtherBill"("recognitionDate");
CREATE INDEX "OtherBill_category_idx" ON "OtherBill"("category");
CREATE INDEX "OtherBill_paymentStatus_idx" ON "OtherBill"("paymentStatus");
CREATE INDEX "OtherBill_projectId_idx" ON "OtherBill"("projectId");
CREATE INDEX "OtherBill_staffId_idx" ON "OtherBill"("staffId");
