import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@/generated/prisma/client'
import { resolveDatabaseUrl } from '@/lib/database-url'
import { retryOnBusy } from '@/lib/sqlite-busy'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaVersion?: string }
const SCHEMA_VERSION = 'v47'

function applySqlitePragmas(client: PrismaClient, url: string) {
  if (!url.startsWith('file:')) return
  // WAL removes reader/writer contention and busy_timeout lets a second writer wait
  // instead of failing instantly; both are per-connection so they are set on every client.
  client.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    .then(() => client.$queryRawUnsafe('PRAGMA busy_timeout=5000'))
    .catch(err => console.error('[db] failed to apply SQLite pragmas', err))
}

function createPrisma(): PrismaClient {
  const url = resolveDatabaseUrl()
  const adapter = new PrismaLibSql({ url })
  const client = new PrismaClient({ adapter })
  const extended = client.$extends({
    query: {
      $allOperations: ({ args, query }) => retryOnBusy(() => query(args)),
    },
  }) as unknown as PrismaClient
  applySqlitePragmas(extended, url)
  return extended
}

// One client per process in every environment. Next.js bundles this module into
// several chunks (instrumentation, route groups), so a module-local singleton would
// open one libsql connection per copy.
const needsReset = !globalForPrisma.prisma || globalForPrisma.prismaVersion !== SCHEMA_VERSION
export const prisma: PrismaClient = needsReset ? createPrisma() : globalForPrisma.prisma!

globalForPrisma.prisma = prisma
globalForPrisma.prismaVersion = SCHEMA_VERSION
