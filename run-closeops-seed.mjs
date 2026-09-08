import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedCloseops } from './prisma/seeds/closeops.ts'
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
const org = await db.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })
const users = await db.user.findMany({
  where: { organizationId: org.id, deletedAt: null },
  select: { id: true, email: true, role: { select: { key: true } } },
})
await seedCloseops(db, { organizationId: org.id, users: users.map((u) => ({ id: u.id, email: u.email, role: u.role.key })), clientIds: [] })
const hot = await db.client.count({ where: { organizationId: org.id, aiCloseProbability: { gte: 80 }, currentStage: { isTerminal: false, category: { not: 'SUBMISSION' } }, status: 'ACTIVE' } })
console.log(`callable hot leads at 80+: ${hot}`)
await db.$disconnect()
