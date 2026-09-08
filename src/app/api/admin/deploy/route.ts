import { recordAudit } from '@/lib/audit'
import { startDeploy } from '@/lib/deploy'
import { guardDeploy } from './guard'

/**
 * POST /api/admin/deploy — launch a production deploy (owner + step-up only).
 * Refuses while a deploy is already RUNNING (DeployRun row or lockfile). The
 * script is spawned detached because it restarts the very service handling
 * this request; on non-Linux hosts it degrades to a labelled mock deploy.
 */
export async function POST() {
  const gate = await guardDeploy()
  if (!gate.ok) return gate.response

  const result = await startDeploy(gate.user)
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 })

  await recordAudit(gate.user, {
    action: 'system.deploy',
    entityType: 'DeployRun',
    entityId: result.runId,
    summary: `Production deploy started (${result.mode} mode).`,
  })
  return Response.json(result)
}
