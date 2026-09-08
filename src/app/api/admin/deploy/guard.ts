import 'server-only'
import { getSessionUser, type SessionUser } from '@/lib/rbac'
import { requireStepUp, StepUpRequiredError } from '@/lib/stepup'

export type DeployGuard = { ok: true; user: SessionUser } | { ok: false; response: Response }

/**
 * The single gate for every /api/admin/deploy/* handler: signed-in, the
 * organization OWNER (deliberately no permission key — this console cannot be
 * granted to a role), and holding a fresh 'deploy' step-up grant. The
 * <StepUpGate> on the page is UX only; THIS is the security boundary.
 */
export async function guardDeploy(): Promise<DeployGuard> {
  const user = await getSessionUser()
  if (!user) {
    return { ok: false, response: Response.json({ error: 'Unauthorized.' }, { status: 401 }) }
  }
  if (!user.isOwner) {
    return { ok: false, response: Response.json({ error: 'Owner only.' }, { status: 403 }) }
  }
  try {
    await requireStepUp(user, 'deploy')
  } catch (e) {
    if (e instanceof StepUpRequiredError) {
      return {
        ok: false,
        response: Response.json({ error: e.message, stepUpRequired: true }, { status: 403 }),
      }
    }
    throw e
  }
  return { ok: true, user }
}
