/** Minimal, non-destructive local seed for the two-role Team Prodigy workspace. */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { db } from '../src/lib/db'
import { bootstrapOrganization } from '../src/lib/org/bootstrap'
import { isLocalDatabaseUrl } from '../src/lib/pg-env'

async function main() {
  if (!process.env.DATABASE_URL || !isLocalDatabaseUrl(process.env.DATABASE_URL)) throw new Error('Demo seeding is local-only. Use the reviewed workspace migration for existing remote data.')
  const password = process.env.DEMO_STAFF_PASSWORD
  if (!password) throw new Error('Set DEMO_STAFF_PASSWORD before seeding.')
  if (await db.organization.count({ where: { slug: { not: 'prodigyflo' } } })) throw new Error('This database contains other workspaces. Seed an empty local database; existing workspaces require the migration.')
  const { organizationId, roleIdByKey } = await bootstrapOrganization(db, { name: 'Team Prodigy', slug: 'prodigyflo' })
  const team = await db.team.findFirstOrThrow({ where: { organizationId, name: 'Team Prodigy' } })
  const passwordHash = await bcrypt.hash(password, 10)
  for (const [key, email, name] of [
    ['SUPER_ADMIN', 'admin@prodigyflo.ai', 'Demo Super Admin'],
    ['CLOSER', 'closer@prodigyflo.ai', 'Demo Closer'],
  ] as const) {
    await db.user.upsert({ where: { organizationId_email: { organizationId, email } }, update: {}, create: {
      organizationId, roleId: roleIdByKey.get(key)!, teamId: team.id, email, name, passwordHash, isOwner: false,
    } })
  }
  console.log('Team Prodigy is initialized with Super Admin and Closer demo accounts. Existing records and passwords were preserved.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => db.$disconnect())
