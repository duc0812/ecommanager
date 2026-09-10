-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppUser" ("createdAt", "email", "id", "name", "passwordHash", "permissions", "role", "status", "updatedAt") SELECT "createdAt", "email", "id", "name", "passwordHash", "permissions", "role", "status", "updatedAt" FROM "AppUser";
DROP TABLE "AppUser";
ALTER TABLE "new_AppUser" RENAME TO "AppUser";
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
