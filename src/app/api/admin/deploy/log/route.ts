import type { NextRequest } from 'next/server'
import { readDeployLog } from '@/lib/deploy'
import { guardDeploy } from '../guard'

/**
 * GET /api/admin/deploy/log?offset=N — offset-based slice of the deploy log
 * (the same serve-a-project-file shape as /api/reports/[name], but JSON so the
 * poller gets `nextOffset` + run status alongside the text). Bad offsets are
 * clamped server-side; the response never exposes anything but the log file
 * configured in DEPLOY_LOG.
 */
export async function GET(req: NextRequest) {
  const gate = await guardDeploy()
  if (!gate.ok) return gate.response

  const offset = Number(req.nextUrl.searchParams.get('offset') ?? '0')
  const slice = await readDeployLog(offset)
  return Response.json(slice, { headers: { 'Cache-Control': 'no-store' } })
}
