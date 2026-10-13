import { getSessionUser } from '@/lib/rbac'
import { staffRouteAllowed } from '@/lib/staff-routes'
import { deskVersion } from '@/lib/call-center/desk-version'

/**
 * GET /api/call-center/version: the desk's change fingerprint for the 20 s
 * live refresh (lib/call-center/desk-version.ts). An opaque hash, never data.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'no-store' }

export async function GET() {
  const user = await getSessionUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: NO_STORE })
  if (!staffRouteAllowed(user.role, '/api/call-center/version')) return Response.json({ ok: false, error: 'forbidden' }, { status: 403, headers: NO_STORE })
  return Response.json({ ok: true, v: await deskVersion(user) }, { headers: NO_STORE })
}
