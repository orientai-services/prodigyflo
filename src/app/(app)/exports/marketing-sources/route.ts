import { can, requireUser } from '@/lib/rbac'
import { getMarketingOverview, marketingRange } from '@/lib/marketing-metrics'
import { recordAudit } from '@/lib/audit'
import {
  MARKETING_SOURCE_HEADERS,
  csvResponse,
  exportFilename,
  marketingSourceCsvRows,
} from '@/lib/export-csv'

/**
 * GET /exports/marketing-sources?range=30|60|90 — the /marketing/sources
 * rollup as CSV. Same gate, same range, same scoped rollup as the page;
 * exports are data egress, so every download is audited with its row count.
 */
export async function GET(request: Request) {
  const user = await requireUser()
  // Mirrors /marketing/sources: requirePermissionPage('analytics:marketing').
  if (!can(user, 'analytics:marketing')) return new Response('Forbidden', { status: 403 })

  const sp = new URL(request.url).searchParams
  const range = marketingRange(sp.get('range') ?? undefined)
  const { sources } = await getMarketingOverview(user, range)

  await recordAudit(user, {
    action: 'export.csv',
    entityType: 'Export',
    summary: `Exported lead-source CSV — ${sources.length} rows (${range.label.toLowerCase()})`,
    after: { export: 'marketing-sources', range: range.key, rowCount: sources.length },
  })

  return csvResponse(
    exportFilename('lead-sources', new Date()),
    MARKETING_SOURCE_HEADERS,
    marketingSourceCsvRows(sources),
  )
}
