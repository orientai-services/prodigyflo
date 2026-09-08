import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { canAny, findClientInScope, getSessionUser } from '@/lib/rbac'
import { recordAudit } from '@/lib/audit'

/**
 * Downloads the stored CYS handover package as a JSON file. There is no CYS
 * API — staff deliver this file manually. Generation happens via the server
 * action; this route only streams what an approver already signed off on.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<'/api/cys/[clientId]/package'>) {
  const { clientId } = await ctx.params

  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (!canAny(user, ['submissions:read', 'submissions:prepare'])) {
    return new Response('Forbidden', { status: 403 })
  }

  const client = await findClientInScope(user, clientId)
  if (!client) return new Response('Not found', { status: 404 })

  const readiness = await db.cysReadiness.findUnique({ where: { clientId } })
  if (!readiness?.approvedAt) {
    return new Response('This client has not been approved as CYS ready.', { status: 409 })
  }
  if (!readiness.packageJson || !readiness.packageGeneratedAt) {
    return new Response('No package has been generated yet.', { status: 409 })
  }

  await recordAudit(user, {
    action: 'cys.package_downloaded',
    entityType: 'Client',
    entityId: clientId,
    summary: `Downloaded CYS package generated ${readiness.packageGeneratedAt.toISOString()}`,
  })

  const stamp = readiness.packageGeneratedAt.toISOString().slice(0, 10)
  return new Response(JSON.stringify(readiness.packageJson, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="cys-package-${clientId}-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
