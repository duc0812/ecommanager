import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@/generated/prisma/client'
import { resolveDatabaseUrl } from '@/lib/database-url'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; prismaVersion?: string }
const SCHEMA_VERSION = 'v38'

function createPrisma() {
  const adapter = new PrismaLibSql({ url: resolveDatabaseUrl() })
  return new PrismaClient({ adapter })
}

const needsReset = !globalForPrisma.prisma || globalForPrisma.prismaVersion !== SCHEMA_VERSION
export const prisma = needsReset ? createPrisma() : globalForPrisma.prisma

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaVersion = SCHEMA_VERSION
}
