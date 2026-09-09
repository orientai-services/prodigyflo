import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { pgPoolMax, pgSsl } from '@/lib/pg-env'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

const createClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      ssl: pgSsl(connectionString),
      max: pgPoolMax(),
      idleTimeoutMillis: 30_000,
    }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> }

export const db = globalForPrisma.prisma ?? createClient()
globalForPrisma.prisma = db
