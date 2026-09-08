import { getDeployStatus } from '@/lib/deploy'
import { guardDeploy } from '../guard'

/**
 * GET /api/admin/deploy/status — light status for the console header pills:
 * service active?, current RUNNING deploy, last finished outcome. Reconciles
 * stale RUNNING rows on every read (the deploy kills its own launcher, so
 * finalization happens here). Deliberately no git fetch — version info is
 * fetched once per page load in the RSC, not on the poll path.
 */
export async function GET() {
  const gate = await guardDeploy()
  if (!gate.ok) return gate.response

  const status = await getDeployStatus()
  return Response.json(status, { headers: { 'Cache-Control': 'no-store' } })
}
