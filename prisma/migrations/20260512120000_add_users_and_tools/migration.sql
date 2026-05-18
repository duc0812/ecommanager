CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ResourceProxy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT,
    "port" TEXT,
    "username" TEXT,
    "password" TEXT,
    "provider" TEXT,
    "tags" TEXT,
    "purchaseDate" TEXT,
    "expireDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'MAINTAIN',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ToolAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "proxyId" TEXT,
    "tags" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ToolAccount_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "ResourceProxy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");
CREATE INDEX "ResourceProxy_status_idx" ON "ResourceProxy"("status");
CREATE INDEX "ToolAccount_accountType_idx" ON "ToolAccount"("accountType");
CREATE INDEX "ToolAccount_status_idx" ON "ToolAccount"("status");
CREATE INDEX "ToolAccount_proxyId_idx" ON "ToolAccount"("proxyId");
