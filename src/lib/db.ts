import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@/generated/prisma/client'
import { resolveDatabaseUrl } from '@/lib/database-url'
import { retryOnBusy } from '@/lib/sqlite-busy'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; prismaVersion?: string }
const SCHEMA_VERSION = 'v44'

function createPrisma(): PrismaClient {
  const adapter = new PrismaLibSql({ url: resolveDatabaseUrl() })
  const client = new PrismaClient({ adapter })
  const extended = client.$extends({
    query: {
      $allOperations: ({ args, query }) => retryOnBusy(() => query(args)),
    },
  })
  return extended as unknown as PrismaClient
}

const needsReset = !globalForPrisma.prisma || globalForPrisma.prismaVersion !== SCHEMA_VERSION
export const prisma = needsReset ? createPrisma() : globalForPrisma.prisma

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaVersion = SCHEMA_VERSION
}
