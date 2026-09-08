import { requireUser } from '@/lib/rbac'
import { listCoachingNotes, salesLevel } from '@/lib/coaching'
import { recordAudit } from '@/lib/audit'
import { COACHING_HEADERS, coachingCsvRows, csvResponse, exportFilename } from '@/lib/export-csv'

/**
 * GET /exports/coaching — every coaching note the caller may read (the
 * /sales/coaching feed's visibility rules, uncapped to a hard export limit).
 * Same gate as the page; audited because exports are data egress.
 */

/** Hard cap: an export is a report, not a bulk data extraction channel. */
const MAX_ROWS = 2000

export async function GET() {
  const user = await requireUser()
  // Mirrors /sales/coaching: requireSalesAccess() — any analytics level incl. self.
  if (!salesLevel(user)) return new Response('Forbidden', { status: 403 })

  const notes = await listCoachingNotes(user, MAX_ROWS)

  await recordAudit(user, {
    action: 'export.csv',
    entityType: 'Export',
    summary: `Exported coaching-notes CSV — ${notes.length} rows`,
    after: { export: 'coaching', rowCount: notes.length },
  })

  return csvResponse(exportFilename('coaching', new Date()), COACHING_HEADERS, coachingCsvRows(notes))
}
