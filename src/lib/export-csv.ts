import type { ScoreboardRow } from '@/lib/scoreboard'
import type { CampaignRollup, SourceRollup } from '@/lib/marketing-metrics'
import type { CoachingNoteRow } from '@/lib/coaching'

/**
 * CSV export plumbing for the /exports/* download routes.
 *
 * Everything here is pure so the escaping and row shaping are unit-testable
 * (export-csv.test.ts). Route handlers own auth, scoping, and auditing —
 * this module only turns already-scoped rows into a spreadsheet-safe file.
 * Deliberately not 'server-only': like csv.ts, nothing here touches the db.
 */

export type CsvCell = string | number | boolean | Date | null | undefined

/**
 * RFC 4180 quoting — a stray comma or quote must not shift a column — plus a
 * formula-injection guard: a string cell starting with = + - @ TAB or CR would
 * execute as a formula when the export opens in Excel/Sheets, so it is
 * neutralized with a leading apostrophe and force-quoted. Numbers and booleans
 * are never strings here, so they stay raw (a -3 exports as -3).
 */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  let s = value instanceof Date ? value.toISOString() : String(value)
  const dangerous = /^[=+\-@\t\r]/.test(s)
  if (dangerous) s = `'${s}`
  return dangerous || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** UTF-8 BOM so Excel opens accented names correctly without an import wizard. */
export const BOM = String.fromCharCode(0xfeff)

/** Full file body: BOM + header line + CRLF rows. Dates ISO, numbers raw. */
export function toCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  return (
    BOM +
    [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') +
    '\r\n'
  )
}

/** prodigyflo-<slug>-YYYY-MM-DD.csv — date of the request, not of the build. */
export function exportFilename(slug: string, now: Date): string {
  return `prodigyflo-${slug}-${now.toISOString().slice(0, 10)}.csv`
}

/** A ready-to-return CSV download. `filename` should come from exportFilename. */
export function csvResponse(
  filename: string,
  headers: readonly string[],
  rows: readonly CsvCell[][],
): Response {
  return new Response(toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

// ── Row shaping (pure — the numbers stay exactly what the pages show) ────────

const r1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10)
const r2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100)

export const SCOREBOARD_HEADERS = [
  'rank', 'closer', 'team', 'points', 'pipeline', 'leaking', 'capacity',
  'qualified_won', 'qualified_lost', 'close_rate_pct', 'wins', 'hot_wins',
  'revenue_won', 'avg_ai_prob_on_won_pct', 'ai_alignment_pct', 'ai_read_sample',
  'calls', 'briefed_calls',
  'brief_adoption_pct', 'adherence_pct', 'adherence_calls',
  'full_funnel_calls', 'qa_avg', 'qa_count', 'coaching_sessions',
] as const

export function scoreboardCsvRows(rows: readonly ScoreboardRow[]): CsvCell[][] {
  return rows.map((r) => [
    r.rank, r.name, r.teamName, r.points, r.pipeline, r.leaking, r.capacity,
    r.qualifiedWon, r.qualifiedLost, r.closeRatePct, r.wins, r.hotWins,
    r.revenueWon, r.avgAiProbOnWonPct, r.aiAlignmentPct, r.aiReadSample,
    r.calls, r.briefedCalls,
    r.briefAdoptionPct, r.adherencePct, r.adherenceCalls,
    r.fullFunnelCalls, r.qaAvg, r.qaCount, r.coachingSessions,
  ])
}

export const MARKETING_SOURCE_HEADERS = [
  'source', 'channel', 'active', 'leads', 'qualified', 'qualified_rate_pct',
  'won', 'won_rate_pct',
] as const

export function marketingSourceCsvRows(rows: readonly SourceRollup[]): CsvCell[][] {
  return rows.map((s) => [
    s.name, s.channel, s.isActive, s.leads, s.qualified, r1(s.qualifiedRate),
    s.won, r1(s.wonRate),
  ])
}

export const MARKETING_CAMPAIGN_HEADERS = [
  'campaign', 'source', 'channel', 'status', 'leads', 'qualified',
  'qualified_rate_pct', 'won', 'won_rate_pct', 'spend', 'impressions',
  'clicks', 'ctr_pct', 'ad_reported_leads', 'cost_per_lead',
  'cost_per_qualified',
] as const

export function marketingCampaignCsvRows(rows: readonly CampaignRollup[]): CsvCell[][] {
  return rows.map((c) => [
    c.name, c.sourceName, c.channel, c.status, c.leads, c.qualified,
    r1(c.qualifiedRate), c.won, r1(c.wonRate), r2(c.spend), c.impressions,
    c.clicks, r1(c.ctr), c.adLeads, r2(c.costPerLead), r2(c.costPerQualified),
  ])
}

export const COACHING_HEADERS = [
  'created_at', 'kind', 'subject', 'author', 'score', 'client',
  'strengths', 'improvements', 'body',
] as const

export function coachingCsvRows(rows: readonly CoachingNoteRow[]): CsvCell[][] {
  return rows.map((n) => [
    n.createdAt, n.kind, n.subject.name, n.author.name, n.score,
    n.client ? `${n.client.firstName} ${n.client.lastName}` : null,
    n.strengths, n.improvements, n.body,
  ])
}
