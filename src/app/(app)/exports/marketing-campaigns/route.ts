import { can, requireUser } from '@/lib/rbac'
import { getMarketingOverview, marketingRange } from '@/lib/marketing-metrics'
import { recordAudit } from '@/lib/audit'
import {
  MARKETING_CAMPAIGN_HEADERS,
  csvResponse,
  exportFilename,
  marketingCampaignCsvRows,
} from '@/lib/export-csv'

/**
 * GET /exports/marketing-campaigns?range=30|60|90 — the campaign rollup
 * (funnel + in-range ad spend) shown on /marketing as CSV. Same gate, same
 * range, same scoped rollup as the page; audited because exports are egress.
 */
export async function GET(request: Request) {
  const user = await requireUser()
  // Mirrors /marketing: requirePermissionPage('analytics:marketing').
  if (!can(user, 'analytics:marketing')) return new Response('Forbidden', { status: 403 })

  const sp = new URL(request.url).searchParams
  const range = marketingRange(sp.get('range') ?? undefined)
  const { campaigns } = await getMarketingOverview(user, range)

  await recordAudit(user, {
    action: 'export.csv',
    entityType: 'Export',
    summary: `Exported campaign CSV — ${campaigns.length} rows (${range.label.toLowerCase()})`,
    after: { export: 'marketing-campaigns', range: range.key, rowCount: campaigns.length },
  })

  return csvResponse(
    exportFilename('campaigns', new Date()),
    MARKETING_CAMPAIGN_HEADERS,
    marketingCampaignCsvRows(campaigns),
  )
}
