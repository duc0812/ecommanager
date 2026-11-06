-- CreateTable
CREATE TABLE "ScaleTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "blankFile" TEXT,
    "blankDescription" TEXT NOT NULL DEFAULT '',
    "unprintedParts" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "candidateFile" TEXT,
    "candidateTaskId" TEXT,
    "candidateStatus" TEXT,
    "candidateError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ScaleJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'describing',
    "designJson" TEXT,
    "prompt" TEXT,
    "sourceFile" TEXT,
    "resultFile" TEXT,
    "providerTaskId" TEXT,
    "resultUrl" TEXT,
    "error" TEXT,
    "cost" TEXT,
    "durationMs" INTEGER,
    "parentJobId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ScaleTarget_sku_key" ON "ScaleTarget"("sku");

-- CreateIndex
CREATE INDEX "ScaleJob_createdAt_idx" ON "ScaleJob"("createdAt");

-- Seed the first target list (inactive until a blank and description are added)
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_fehovn', 'All-over Print Fleece Zip Hoodie', 'FEHOVN', 1, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_flhdvn', 'All over Print Fleece Hoodie', 'FLHDVN', 2, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_febovn', 'All-over Print Fleece Bomber Jacket', 'FEBOVN', 3, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_bojavn', 'All-over Print Bomber Jacket', 'BOJAVN', 4, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_bbjavn', 'All-over Print Baseball Jacket', 'BBJAVN', 5, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_hbbjvn', 'All-over Print Hooded Baseball Jacket', 'HBBJVN', 6, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_qubovn', 'All-over Print Quilt Bomber Jacket', 'QUBOVN', 7, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_hclkvn', 'All-over Print Hooded Cloak Coat', 'HCLKVN', 8, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_mwhdvn', 'All-over Print Hoodie (Midweight)', 'MWHDVN', 9, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_mwzhvn', 'All-over Print Zip Hoodie (Midweight)', 'MWZHVN', 10, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_mwssvn', 'All-over Print Sweatshirt (Midweight)', 'MWSSVN', 11, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_t5havn', 'All-over Print Unisex T-shirt', 'T5HAVN', 12, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_knswvn', 'All-over Print Knitted Sweater', 'KNSWVN', 13, CURRENT_TIMESTAMP);
INSERT INTO "ScaleTarget" ("id", "name", "sku", "sortOrder", "updatedAt") VALUES ('scale_kncavn', 'All-over Print Knitted Cardigan', 'KNCAVN', 14, CURRENT_TIMESTAMP);
