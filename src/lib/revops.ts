import type { AttributionTouch, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { DEFAULT_STAGES, stageLabel } from '@/lib/pipeline'
import { rate } from '@/lib/format'

/**
 * RevOps aggregations: revenue attribution, measured-probability forecasting,
 * and customer-journey timing. The compute* functions are pure and fixture-
 * tested; the get*Report loaders only fetch scoped rows and feed them in.
 *
 * Modeling choices, stated once and shown in the UI too:
 *  - First-touch = the earliest AttributionEvent (an explicit FIRST marker
 *    wins over ordering); last-touch = the latest (explicit LAST wins).
 *    A client with no events falls back to their own campaign/source for both.
 *  - Revenue = closed-won deal value; a won client without a deal row falls
 *    back to estimatedValue, matching src/lib/analytics.ts.
 *  - Stage probability = among clients who ever ENTERED the stage and whose
 *    outcome is decided (closed won or lost), the share that reached
 *    CLOSED_WON. Open clients don't count toward n — counting them would
 *    bias every stage downward.
 */

const num = (d: { toString(): string } | number | null | undefined): number => {
  if (d === null || d === undefined) return 0
  const n = typeof d === 'number' ? d : Number(d.toString())
  return Number.isFinite(n) ? n : 0
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ─────────────────────────────────────────────────────────────
// Attribution (pure)
// ─────────────────────────────────────────────────────────────

export type TouchInput = {
  campaignId: string | null
  leadSourceId: string | null
  touch: AttributionTouch
  occurredAt: Date
}

export type AttributionClientInput = {
  id: string
  campaignId: string | null
  leadSourceId: string | null
  won: boolean
  revenue: number
  events: TouchInput[]
}

export type AttributionChannelInput = {
  campaigns: { id: string; name: string; channel: string | null; spend: number }[]
  sources: { id: string; name: string; channel: string | null }[]
}

export type AttributionRow = {
  key: string
  name: string
  channel: string | null
  kind: 'campaign' | 'source' | 'direct'
  /** Null when no spend is tracked for this row (sources, direct). */
  spend: number | null
  touches: number
  leadsFirst: number
  leadsLast: number
  wonFirst: number
  wonLast: number
  revenueFirst: number
  revenueLast: number
  /** Spend ÷ first-touch leads; null without tracked spend. */
  cplFirst: number | null
  cplLast: number | null
}

/** Earliest event wins first touch; an explicit FIRST marker outranks ordering. */
export function pickTouch(events: TouchInput[], which: 'FIRST' | 'LAST'): TouchInput | null {
  if (!events.length) return null
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  if (which === 'FIRST') {
    return sorted.find((e) => e.touch === 'FIRST') ?? sorted[0]
  }
  const marked = [...sorted].reverse().find((e) => e.touch === 'LAST')
  return marked ?? sorted[sorted.length - 1]
}

function touchKey(t: { campaignId: string | null; leadSourceId: string | null } | null): string {
  if (t?.campaignId) return `campaign:${t.campaignId}`
  if (t?.leadSourceId) return `source:${t.leadSourceId}`
  return 'direct'
}

export function computeAttribution(
  clients: AttributionClientInput[],
  channels: AttributionChannelInput,
): AttributionRow[] {
  const rows = new Map<string, AttributionRow>()

  const ensure = (key: string): AttributionRow => {
    let row = rows.get(key)
    if (row) return row
    if (key.startsWith('campaign:')) {
      const c = channels.campaigns.find((x) => `campaign:${x.id}` === key)
      row = {
        key,
        name: c?.name ?? 'Unknown campaign',
        channel: c?.channel ?? null,
        kind: 'campaign',
        spend: c ? c.spend : null,
        touches: 0, leadsFirst: 0, leadsLast: 0, wonFirst: 0, wonLast: 0,
        revenueFirst: 0, revenueLast: 0, cplFirst: null, cplLast: null,
      }
    } else if (key.startsWith('source:')) {
      const s = channels.sources.find((x) => `source:${x.id}` === key)
      row = {
        key,
        name: s?.name ?? 'Unknown source',
        channel: s?.channel ?? null,
        kind: 'source',
        spend: null,
        touches: 0, leadsFirst: 0, leadsLast: 0, wonFirst: 0, wonLast: 0,
        revenueFirst: 0, revenueLast: 0, cplFirst: null, cplLast: null,
      }
    } else {
      row = {
        key: 'direct',
        name: 'Direct / untracked',
        channel: null,
        kind: 'direct',
        spend: null,
        touches: 0, leadsFirst: 0, leadsLast: 0, wonFirst: 0, wonLast: 0,
        revenueFirst: 0, revenueLast: 0, cplFirst: null, cplLast: null,
      }
    }
    rows.set(key, row)
    return row
  }

  for (const client of clients) {
    for (const event of client.events) ensure(touchKey(event)).touches += 1

    // No recorded touches → the client's own campaign/source stands in for both models.
    const fallback = { campaignId: client.campaignId, leadSourceId: client.leadSourceId }
    const first = pickTouch(client.events, 'FIRST') ?? fallback
    const last = pickTouch(client.events, 'LAST') ?? fallback

    const firstRow = ensure(touchKey(first))
    firstRow.leadsFirst += 1
    if (client.won) {
      firstRow.wonFirst += 1
      firstRow.revenueFirst += client.revenue
    }

    const lastRow = ensure(touchKey(last))
    lastRow.leadsLast += 1
    if (client.won) {
      lastRow.wonLast += 1
      lastRow.revenueLast += client.revenue
    }
  }

  for (const row of rows.values()) {
    if (row.spend !== null && row.spend > 0) {
      row.cplFirst = row.leadsFirst ? row.spend / row.leadsFirst : null
      row.cplLast = row.leadsLast ? row.spend / row.leadsLast : null
    }
  }

  return [...rows.values()].sort(
    (a, b) => b.revenueFirst - a.revenueFirst || b.leadsFirst - a.leadsFirst,
  )
}

// ─────────────────────────────────────────────────────────────
// Forecast (pure)
// ─────────────────────────────────────────────────────────────

export type Outcome = 'WON' | 'LOST' | 'OPEN'

export type StageWinRate = {
  stageKey: StageKey
  /** Decided clients (won or lost) that ever entered the stage. */
  n: number
  won: number
  /** 0..1, or null when the stage has no decided history at all. */
  probability: number | null
}

/**
 * Measured stage-progression probability: of the clients who entered each
 * stage AND have a decided outcome, the share that closed won.
 */
export function measureStageWinRates(
  entries: { clientId: string; toKey: StageKey }[],
  outcomes: Map<string, Outcome>,
): Map<StageKey, StageWinRate> {
  const enteredBy = new Map<StageKey, Set<string>>()
  for (const e of entries) {
    const set = enteredBy.get(e.toKey) ?? new Set<string>()
    set.add(e.clientId)
    enteredBy.set(e.toKey, set)
  }

  const rates = new Map<StageKey, StageWinRate>()
  for (const [stageKey, clientIds] of enteredBy) {
    let n = 0
    let won = 0
    for (const id of clientIds) {
      const outcome = outcomes.get(id)
      if (outcome === 'WON') { n += 1; won += 1 }
      else if (outcome === 'LOST') n += 1
    }
    rates.set(stageKey, { stageKey, n, won, probability: n > 0 ? won / n : null })
  }
  return rates
}

export type OpenClientInput = {
  id: string
  stageKey: StageKey
  estimatedValue: number
  /** Client.probability, 0–100, staff-entered. Used only when the stage lacks history. */
  probability: number | null
  expectedCloseAt: Date | null
}

export type ForecastStageRow = {
  stageKey: StageKey
  label: string
  position: number
  clients: number
  openValue: number
  /** 0..1: measured when n > 0, otherwise null (per-client fallbacks still weight the value). */
  measuredProbability: number | null
  n: number
  probabilitySource: 'measured' | 'client-fallback' | 'none'
  weightedValue: number
}

export type ForecastSummary = {
  stages: ForecastStageRow[]
  weightedTotal: number
  openTotal: number
  /** Open value that carries NO probability at all — excluded from the weighted total. */
  unweightedValue: number
  unweightedClients: number
}

const STAGE_META = new Map(DEFAULT_STAGES.map((s) => [s.key, s]))

export function computeForecast(
  open: OpenClientInput[],
  rates: Map<StageKey, StageWinRate>,
): ForecastSummary {
  const byStage = new Map<StageKey, OpenClientInput[]>()
  for (const c of open) {
    const list = byStage.get(c.stageKey) ?? []
    list.push(c)
    byStage.set(c.stageKey, list)
  }

  const stages: ForecastStageRow[] = []
  let weightedTotal = 0
  let openTotal = 0
  let unweightedValue = 0
  let unweightedClients = 0

  for (const [stageKey, clients] of byStage) {
    const meta = STAGE_META.get(stageKey)
    const measured = rates.get(stageKey)
    const hasMeasured = (measured?.n ?? 0) > 0

    let stageWeighted = 0
    let stageValue = 0
    let usedFallback = false
    for (const c of clients) {
      stageValue += c.estimatedValue
      if (hasMeasured) {
        stageWeighted += c.estimatedValue * (measured!.probability as number)
      } else if (c.probability !== null) {
        stageWeighted += c.estimatedValue * (Math.min(100, Math.max(0, c.probability)) / 100)
        usedFallback = true
      } else {
        unweightedValue += c.estimatedValue
        unweightedClients += 1
      }
    }

    stages.push({
      stageKey,
      label: stageLabel(stageKey),
      position: meta?.position ?? 99,
      clients: clients.length,
      openValue: stageValue,
      measuredProbability: hasMeasured ? (measured!.probability as number) : null,
      n: measured?.n ?? 0,
      probabilitySource: hasMeasured ? 'measured' : usedFallback ? 'client-fallback' : 'none',
      weightedValue: stageWeighted,
    })
    weightedTotal += stageWeighted
    openTotal += stageValue
  }

  stages.sort((a, b) => a.position - b.position)
  return { stages, weightedTotal, openTotal, unweightedValue, unweightedClients }
}

// ─────────────────────────────────────────────────────────────
// Journey (pure)
// ─────────────────────────────────────────────────────────────

export type StageStayInput = {
  clientId: string
  toKey: StageKey
  enteredAt: Date
  exitedAt: Date | null
  durationMinutes: number | null
}

export type JourneyStageRow = {
  stageKey: StageKey
  label: string
  position: number
  /** Distinct clients that ever entered the stage. */
  entered: number
  /** Median minutes of COMPLETED stays; null with no measured stay. */
  medianMinutes: number | null
  staysMeasured: number
  /** Entered clients with a decided outcome. */
  decided: number
  /** % of decided clients that closed won; null when nobody decided. */
  wonShare: number | null
  belowMinimumSample: boolean
}

export type JourneySummary = {
  stages: JourneyStageRow[]
  medianLeadToCloseDays: number | null
  wonSample: number
  /** Non-terminal stages with the lowest measured win share at adequate sample. */
  biggestDropoffs: JourneyStageRow[]
}

export function computeJourney(
  stays: StageStayInput[],
  outcomes: Map<string, Outcome>,
  minimumSample: number,
): JourneySummary {
  const byStage = new Map<StageKey, StageStayInput[]>()
  for (const s of stays) {
    const list = byStage.get(s.toKey) ?? []
    list.push(s)
    byStage.set(s.toKey, list)
  }

  const stages: JourneyStageRow[] = []
  for (const meta of DEFAULT_STAGES) {
    const list = byStage.get(meta.key) ?? []
    if (!list.length) continue

    const clients = new Set(list.map((s) => s.clientId))
    const durations = list
      .map((s) =>
        s.durationMinutes !== null
          ? s.durationMinutes
          : s.exitedAt
            ? (s.exitedAt.getTime() - s.enteredAt.getTime()) / 60_000
            : null,
      )
      .filter((d): d is number => d !== null && d >= 0)

    let decided = 0
    let won = 0
    for (const id of clients) {
      const outcome = outcomes.get(id)
      if (outcome === 'WON') { decided += 1; won += 1 }
      else if (outcome === 'LOST') decided += 1
    }

    stages.push({
      stageKey: meta.key,
      label: meta.name,
      position: meta.position,
      entered: clients.size,
      medianMinutes: median(durations),
      staysMeasured: durations.length,
      decided,
      wonShare: decided > 0 ? rate(won, decided) : null,
      belowMinimumSample: decided < minimumSample,
    })
  }

  // Lead → close: earliest recorded entry to the CLOSED_WON entry, per won client.
  const firstEntry = new Map<string, number>()
  const wonEntry = new Map<string, number>()
  for (const s of stays) {
    const t = s.enteredAt.getTime()
    const prev = firstEntry.get(s.clientId)
    if (prev === undefined || t < prev) firstEntry.set(s.clientId, t)
    if (s.toKey === 'CLOSED_WON') {
      const prevWon = wonEntry.get(s.clientId)
      if (prevWon === undefined || t < prevWon) wonEntry.set(s.clientId, t)
    }
  }
  const cycles: number[] = []
  for (const [clientId, wonAt] of wonEntry) {
    const start = firstEntry.get(clientId)
    if (start !== undefined && wonAt >= start) cycles.push((wonAt - start) / 86_400_000)
  }

  const rankable = stages.filter(
    (s) =>
      s.wonShare !== null &&
      !s.belowMinimumSample &&
      STAGE_META.get(s.stageKey)?.category !== 'TERMINAL',
  )
  const biggestDropoffs = [...rankable]
    .sort((a, b) => (a.wonShare as number) - (b.wonShare as number))
    .slice(0, 3)

  return {
    stages,
    medianLeadToCloseDays: median(cycles),
    wonSample: cycles.length,
    biggestDropoffs,
  }
}

// ─────────────────────────────────────────────────────────────
// DB loaders
// ─────────────────────────────────────────────────────────────

/** Org setting used everywhere a small sample would mislead; default 10. */
export async function getMinimumSample(organizationId: string): Promise<number> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  })
  const raw = (org?.settings as Record<string, unknown> | null)?.minimumSampleForRanking
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
}

const TERMINAL_LOST: StageKey[] = ['CLOSED_LOST', 'NOT_QUALIFIED']

type RevopsClientRow = {
  id: string
  campaignId: string | null
  leadSourceId: string | null
  estimatedValue: unknown
  probability: number | null
  expectedCloseAt: Date | null
  createdAt: Date
  currentStage: { key: StageKey }
  deal: { status: string; value: unknown; wonAt: Date | null } | null
  stageHistory: { toKey: StageKey; enteredAt: Date; exitedAt: Date | null; durationMinutes: number | null }[]
  attributionEvents: { campaignId: string | null; leadSourceId: string | null; touch: AttributionTouch; occurredAt: Date }[]
}

async function loadRevopsClients(user: SessionUser): Promise<RevopsClientRow[]> {
  return db.client.findMany({
    where: clientScope(user),
    select: {
      id: true,
      campaignId: true,
      leadSourceId: true,
      estimatedValue: true,
      probability: true,
      expectedCloseAt: true,
      createdAt: true,
      currentStage: { select: { key: true } },
      deal: { select: { status: true, value: true, wonAt: true } },
      stageHistory: { select: { toKey: true, enteredAt: true, exitedAt: true, durationMinutes: true } },
      attributionEvents: {
        select: { campaignId: true, leadSourceId: true, touch: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      },
    },
  }) as unknown as Promise<RevopsClientRow[]>
}

function outcomeOf(row: RevopsClientRow): Outcome {
  if (row.currentStage.key === 'CLOSED_WON' || row.deal?.status === 'WON') return 'WON'
  if (TERMINAL_LOST.includes(row.currentStage.key) || row.deal?.status === 'LOST') return 'LOST'
  return 'OPEN'
}

function wonRevenue(row: RevopsClientRow): number {
  const dealValue = row.deal ? num(row.deal.value as never) : 0
  return dealValue > 0 ? dealValue : num(row.estimatedValue as never)
}

export async function getAttributionReport(user: SessionUser) {
  const [rows, campaigns, sources] = await Promise.all([
    loadRevopsClients(user),
    db.campaign.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, channel: true, spend: true, leadSource: { select: { channel: true } } },
    }),
    db.leadSource.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, channel: true },
    }),
  ])

  const clients: AttributionClientInput[] = rows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    leadSourceId: r.leadSourceId,
    won: outcomeOf(r) === 'WON',
    revenue: outcomeOf(r) === 'WON' ? wonRevenue(r) : 0,
    events: r.attributionEvents,
  }))

  const table = computeAttribution(clients, {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.leadSource?.channel ?? c.channel,
      spend: num(c.spend as never),
    })),
    sources,
  })

  const totals = {
    leads: clients.length,
    won: clients.filter((c) => c.won).length,
    revenue: clients.reduce((sum, c) => sum + c.revenue, 0),
    spend: table.reduce((sum, r) => sum + (r.spend ?? 0), 0),
  }

  return { table, totals }
}

export type ForecastReport = ForecastSummary & {
  minimumSample: number
  trend: { label: string; won: number; forecast: number }[]
  trailingWon90d: number
}

export async function getForecastReport(user: SessionUser): Promise<ForecastReport> {
  const [rows, minimumSample] = await Promise.all([
    loadRevopsClients(user),
    getMinimumSample(user.organizationId),
  ])

  const outcomes = new Map(rows.map((r) => [r.id, outcomeOf(r)]))
  const entries = rows.flatMap((r) => r.stageHistory.map((h) => ({ clientId: r.id, toKey: h.toKey })))
  const rates = measureStageWinRates(entries, outcomes)

  const openRows = rows.filter((r) => outcomeOf(r) === 'OPEN' && r.currentStage.key !== 'ON_HOLD')
  const open: OpenClientInput[] = openRows.map((r) => ({
    id: r.id,
    stageKey: r.currentStage.key,
    estimatedValue: num(r.estimatedValue as never),
    probability: r.probability,
    expectedCloseAt: r.expectedCloseAt,
  }))

  const summary = computeForecast(open, rates)

  // Trailing closed-won by month plus the weighted forecast bucketed by
  // expected close date (missing or past dates land in the current month).
  const now = new Date()
  const monthStart = (offset: number) => new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const monthIndex = (d: Date) =>
    (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth())

  const trend: { label: string; won: number; forecast: number }[] = []
  for (let i = -5; i <= 3; i++) {
    trend.push({
      label: monthStart(i).toLocaleDateString('en-US', { month: 'short' }),
      won: 0,
      forecast: 0,
    })
  }
  const slot = (i: number) => trend[Math.min(Math.max(i + 5, 0), trend.length - 1)]

  let trailingWon90d = 0
  const cutoff90 = new Date(now.getTime() - 90 * 86_400_000)
  for (const r of rows) {
    if (outcomeOf(r) !== 'WON') continue
    const wonAt = r.deal?.wonAt ?? r.stageHistory.find((h) => h.toKey === 'CLOSED_WON')?.enteredAt
    if (!wonAt) continue
    const idx = monthIndex(wonAt)
    if (idx >= -5 && idx <= 0) slot(idx).won += wonRevenue(r)
    if (wonAt >= cutoff90) trailingWon90d += wonRevenue(r)
  }

  const probabilityFor = (c: OpenClientInput): number | null => {
    const measured = rates.get(c.stageKey)
    if ((measured?.n ?? 0) > 0) return measured!.probability as number
    if (c.probability !== null) return Math.min(100, Math.max(0, c.probability)) / 100
    return null
  }
  for (const c of open) {
    const p = probabilityFor(c)
    if (p === null) continue
    const idx = c.expectedCloseAt ? Math.min(Math.max(monthIndex(c.expectedCloseAt), 0), 3) : 0
    slot(idx).forecast += c.estimatedValue * p
  }

  return { ...summary, minimumSample, trend, trailingWon90d }
}

export async function getJourneyReport(user: SessionUser) {
  const [rows, minimumSample] = await Promise.all([
    loadRevopsClients(user),
    getMinimumSample(user.organizationId),
  ])

  const outcomes = new Map(rows.map((r) => [r.id, outcomeOf(r)]))
  const stays: StageStayInput[] = rows.flatMap((r) =>
    r.stageHistory.map((h) => ({ clientId: r.id, ...h })),
  )

  return { ...computeJourney(stays, outcomes, minimumSample), minimumSample, clientCount: rows.length }
}
