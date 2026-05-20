import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@/generated/prisma/client'
import path from 'path'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; prismaVersion?: string }
const SCHEMA_VERSION = 'v14' // bump this to force singleton reset after schema changes

function createPrisma() {
  const dbPath = path.resolve(process.cwd(), 'dev.db')
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` })
  return new PrismaClient({ adapter })
}

const needsReset = !globalForPrisma.prisma || globalForPrisma.prismaVersion !== SCHEMA_VERSION
export const prisma = needsReset ? createPrisma() : globalForPrisma.prisma

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaVersion = SCHEMA_VERSION
}
