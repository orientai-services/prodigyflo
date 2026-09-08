import { requireUser } from '@/lib/rbac'
import { analyticsLevel } from '@/lib/reporting'
import { getCloseOpsConfig } from '@/lib/closeops'
import { getScoreboard, scoreboardRange } from '@/lib/scoreboard'
import { recordAudit } from '@/lib/audit'
import { SCOREBOARD_HEADERS, csvResponse, exportFilename, scoreboardCsvRows } from '@/lib/export-csv'

/**
 * GET /exports/scoreboard?range=week|30|90|all — the /performance table as
 * CSV. Same gate, same range, same scoped query as the page; exports are data
 * egress, so every download is audited with its row count.
 */
export async function GET(request: Request) {
  const user = await requireUser()
  // Mirrors /performance: any analytics level, or a closer's own analytics:self.
  if (!analyticsLevel(user) && !user.permissions.has('analytics:self')) {
    return new Response('Forbidden', { status: 403 })
  }

  const sp = new URL(request.url).searchParams
  const range = scoreboardRange(sp.get('range') ?? undefined)
  const config = await getCloseOpsConfig(user.organizationId)
  const rows = await getScoreboard(user, config, range.from)

  await recordAudit(user, {
    action: 'export.csv',
    entityType: 'Export',
    summary: `Exported closer scoreboard CSV — ${rows.length} rows (${range.label.toLowerCase()})`,
    after: { export: 'scoreboard', range: range.key, rowCount: rows.length },
  })

  return csvResponse(
    exportFilename('scoreboard', new Date()),
    SCOREBOARD_HEADERS,
    scoreboardCsvRows(rows),
  )
}
