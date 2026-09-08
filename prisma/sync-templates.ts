/**
 * Idempotent template sync for existing databases — pure upserts, safe on
 * production, run by deploy.sh when the full (destructive) seed is skipped.
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedMessaging } from './seeds/messaging'
import { seedOutreach } from './seeds/outreach'

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })

  // EVERY organization gets the template sync — under the agency model several
  // live orgs share one database, and a deploy must never leave a newer org
  // behind on template content.
  const orgs = await db.organization.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, slug: true },
  })
  if (orgs.length === 0) {
    console.log('no organization — nothing to sync')
  }
  for (const org of orgs) {
    const users = (
      await db.user.findMany({
        where: { organizationId: org.id },
        select: { id: true, email: true, role: { select: { key: true } } },
      })
    ).map((u) => ({ id: u.id, email: u.email, role: u.role.key as string }))
    const ctx = { organizationId: org.id, users, clientIds: [] as string[] }
    await seedMessaging(db, ctx)
    await seedOutreach(db, ctx)
    console.log(`templates synced for ${org.slug}`)
  }
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
