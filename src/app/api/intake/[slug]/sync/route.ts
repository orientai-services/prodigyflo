import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser, can } from '@/lib/rbac'
import { runSheetSync } from '@/lib/intake/apply'

/**
 * Session-authenticated sync trigger, so an operator (or a future scheduler
 * acting as a user) can kick a sheet pull over HTTP. The settings UI uses the
 * server action instead.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getSessionUser()
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  if (!can(user, 'connectors:manage')) return Response.json({ error: 'Forbidden.' }, { status: 403 })

  const { slug } = await params
  const source = await db.intakeSource.findUnique({
    where: { organizationId_slug: { organizationId: user.organizationId, slug } },
  })
  if (!source) return Response.json({ error: 'Unknown intake source.' }, { status: 404 })

  const result = await runSheetSync(source, { id: user.id, name: user.name, roleName: user.roleName })
  return Response.json(result, { status: result.ok ? 200 : 422 })
}
