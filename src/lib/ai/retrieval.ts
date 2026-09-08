import 'server-only'
import { db } from '@/lib/db'
import { canSeeInternal, clientScope, type SessionUser } from '@/lib/rbac'
import { getAtRiskClients, getLossReasons } from '@/lib/analytics'
import { getMarketingOverview, marketingRange } from '@/lib/marketing-metrics'
import { buildTimeline } from '@/lib/timeline'

/**
 * RAG retrieval for the insight engine and other AI features.
 *
 * `retrieveContext()` runs a set of named retrievers over data the caller is
 * already allowed to see (every query spreads clientScope / pins
 * organizationId) and returns typed, cited snippets — the citations persist on
 * each Insight row as its evidence.
 *
 * The `pastInsights` retriever is the learning loop: it returns previously
 * ACCEPTED and DISMISSED Insight rows with their review notes and measured
 * outcomes, so every new engine run is conditioned on what the organization
 * actually adopted versus rejected.
 *
 * Ranking is keyword scoring + recency over take-capped candidate sets.
 * Upgrade path (deliberately not taken yet — droplet extension/migration
 * rights are unverified): add a pgvector embedding column or a tsvector GIN
 * index per source table and replace `scoreText` with ANN / full-text rank;
 * the retriever interface and snippet shape stay unchanged, so callers never
 * notice the swap.
 */

export type RetrievalSnippet = {
  /** Which retriever produced this ('clients', 'notes', 'pastInsights', …). */
  source: RetrieverKey
  /** Stable citation, e.g. 'note:<id>', 'insight:<id>', 'analytics:loss-reasons'. */
  ref: string
  text: string
}

export type RetrieverKey =
  | 'clients'
  | 'timeline'
  | 'notes'
  | 'communications'
  | 'documents'
  | 'metrics'
  | 'pastInsights'

export type RetrievalStat = { retriever: RetrieverKey; considered: number; returned: number }

export type RetrievalResult = {
  snippets: RetrievalSnippet[]
  stats: RetrievalStat[]
}

export type RetrievalOptions = {
  /** Restrict to these retrievers; defaults to every org-level retriever. */
  retrievers?: RetrieverKey[]
  /** Required for the 'timeline' retriever; it is skipped without one. */
  clientId?: string
  /** Max snippets each retriever may return. */
  perRetrieverLimit?: number
}

const DEFAULT_RETRIEVERS: RetrieverKey[] = [
  'clients',
  'notes',
  'communications',
  'documents',
  'metrics',
  'pastInsights',
]

const DEFAULT_PER_RETRIEVER = 8
/** Candidate rows loaded per source before ranking. */
const CANDIDATE_TAKE = 50
const SNIPPET_CHARS = 400

/** Lowercased search terms: words of 3+ chars, deduped, capped. */
export function keywordTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
  return [...new Set(terms)].slice(0, 12)
}

/** Occurrence count of any term in the text (case-insensitive). */
export function scoreText(text: string, terms: string[]): number {
  if (terms.length === 0) return 0
  const lower = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    let idx = lower.indexOf(term)
    while (idx !== -1) {
      score += 1
      idx = lower.indexOf(term, idx + term.length)
    }
  }
  return score
}

/** Slice a window around the first term hit so the snippet shows its match. */
function excerptAround(text: string, terms: string[], chars = SNIPPET_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const lower = clean.toLowerCase()
  const hit = terms.map((t) => lower.indexOf(t)).find((i) => i >= 0) ?? -1
  const start = hit === -1 ? 0 : Math.max(0, hit - Math.floor(chars / 3))
  const slice = clean.slice(start, start + chars)
  return `${start > 0 ? '…' : ''}${slice}${start + chars < clean.length ? '…' : ''}`
}

/** Keyword score + recency rank over dated candidates; newest breaks ties. */
function rankByRelevance<T extends { text: string; at: Date }>(
  rows: T[],
  terms: string[],
  limit: number,
): T[] {
  return rows
    .map((row, i) => ({ row, score: scoreText(row.text, terms), i }))
    .sort((a, b) => b.score - a.score || b.row.at.getTime() - a.row.at.getTime() || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.row)
}

type Retriever = (
  user: SessionUser,
  terms: string[],
  opts: Required<Pick<RetrievalOptions, 'perRetrieverLimit'>> & { clientId?: string },
) => Promise<{ considered: number; snippets: RetrievalSnippet[] }>

// ─── Retrievers ──────────────────────────────────────────────────────────────

/** Scoped pipeline aggregates: stage counts, at-risk files, loss reasons. */
const retrieveClients: Retriever = async (user, _terms, { perRetrieverLimit }) => {
  const [stageCounts, atRisk, lossReasons] = await Promise.all([
    db.client.groupBy({
      by: ['currentStageId'],
      where: clientScope(user),
      _count: { _all: true },
    }),
    getAtRiskClients(user, 5),
    getLossReasons(user),
  ])
  const stages = await db.pipelineStage.findMany({
    where: { id: { in: stageCounts.map((s) => s.currentStageId) } },
    select: { id: true, name: true, position: true },
  })
  const nameById = new Map(stages.map((s) => [s.id, s]))

  const snippets: RetrievalSnippet[] = []
  if (stageCounts.length > 0) {
    const parts = stageCounts
      .map((s) => ({ stage: nameById.get(s.currentStageId), count: s._count._all }))
      .filter((s) => s.stage)
      .sort((a, b) => a.stage!.position - b.stage!.position)
      .map((s) => `${s.stage!.name}: ${s.count}`)
    snippets.push({
      source: 'clients',
      ref: 'analytics:stage-counts',
      text: `Clients by pipeline stage — ${parts.join(', ')}.`,
    })
  }
  for (const c of atRisk) {
    snippets.push({
      source: 'clients',
      ref: `client:${c.id}`,
      text: `${c.firstName} ${c.lastName} is ${Math.round(c.overBy)}h over the ${c.currentStage.slaHours}h SLA in "${c.currentStage.name}"${c.owner ? ` (owner ${c.owner.name})` : ''}.`,
    })
  }
  if (lossReasons.length > 0) {
    const top = lossReasons.slice(0, 5).map((r) => `${r.reason} (${r.count})`)
    snippets.push({
      source: 'clients',
      ref: 'analytics:loss-reasons',
      text: `Top loss reasons — ${top.join(', ')}.`,
    })
  }
  return {
    considered: stageCounts.length + atRisk.length + lossReasons.length,
    snippets: snippets.slice(0, perRetrieverLimit),
  }
}

/** One client's merged activity feed — only when a clientId is supplied. */
const retrieveTimeline: Retriever = async (user, terms, { perRetrieverLimit, clientId }) => {
  if (!clientId) return { considered: 0, snippets: [] }
  // buildTimeline scopes internal items itself; verify the client is in scope
  // first so the id cannot be used to probe another team's record.
  const inScope = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: clientId }] },
    select: { id: true },
  })
  if (!inScope) return { considered: 0, snippets: [] }

  const page = await buildTimeline(user, clientId, { limit: CANDIDATE_TAKE })
  const ranked = rankByRelevance(
    page.events.map((e) => ({
      e,
      at: e.at,
      text: [e.title, e.description, e.actor].filter(Boolean).join(' — '),
    })),
    terms,
    perRetrieverLimit,
  )
  return {
    considered: page.events.length,
    snippets: ranked.map((r) => ({
      source: 'timeline' as const,
      ref: `timeline:${r.e.id}`,
      text: `[${r.at.toISOString().slice(0, 10)}] ${r.text}`,
    })),
  }
}

const retrieveNotes: Retriever = async (user, terms, { perRetrieverLimit, clientId }) => {
  const rows = await db.note.findMany({
    where: {
      client: clientId ? { AND: [clientScope(user), { id: clientId }] } : clientScope(user),
      ...(canSeeInternal(user) ? {} : { isInternal: false }),
    },
    orderBy: { createdAt: 'desc' },
    take: CANDIDATE_TAKE,
    select: {
      id: true,
      body: true,
      createdAt: true,
      author: { select: { name: true } },
      client: { select: { firstName: true, lastName: true } },
    },
  })
  const ranked = rankByRelevance(
    rows.map((n) => ({ n, at: n.createdAt, text: n.body })),
    terms,
    perRetrieverLimit,
  )
  return {
    considered: rows.length,
    snippets: ranked.map((r) => ({
      source: 'notes' as const,
      ref: `note:${r.n.id}`,
      text: `Note on ${r.n.client.firstName} ${r.n.client.lastName}${r.n.author ? ` by ${r.n.author.name}` : ''} (${r.at.toISOString().slice(0, 10)}): ${excerptAround(r.n.body, terms)}`,
    })),
  }
}

const retrieveCommunications: Retriever = async (user, terms, { perRetrieverLimit, clientId }) => {
  const rows = await db.communication.findMany({
    where: {
      client: clientId ? { AND: [clientScope(user), { id: clientId }] } : clientScope(user),
      ...(canSeeInternal(user) ? {} : { isInternal: false }),
      OR: [{ subject: { not: null } }, { body: { not: null } }],
    },
    orderBy: { occurredAt: 'desc' },
    take: CANDIDATE_TAKE,
    select: {
      id: true,
      channel: true,
      direction: true,
      subject: true,
      body: true,
      occurredAt: true,
      client: { select: { firstName: true, lastName: true } },
    },
  })
  const ranked = rankByRelevance(
    rows.map((c) => ({ c, at: c.occurredAt, text: [c.subject, c.body].filter(Boolean).join(' — ') })),
    terms,
    perRetrieverLimit,
  )
  return {
    considered: rows.length,
    snippets: ranked.map((r) => ({
      source: 'communications' as const,
      ref: `communication:${r.c.id}`,
      text: `${r.c.channel} ${r.c.direction === 'INBOUND' ? 'from' : 'to'} ${r.c.client.firstName} ${r.c.client.lastName} (${r.at.toISOString().slice(0, 10)}): ${excerptAround(r.text, terms)}`,
    })),
  }
}

/** Completed document extractions — rawText slices around the query terms. */
const retrieveDocuments: Retriever = async (user, terms, { perRetrieverLimit, clientId }) => {
  const rows = await db.documentExtraction.findMany({
    where: {
      status: 'COMPLETED',
      rawText: { not: null },
      document: { client: clientId ? { AND: [clientScope(user), { id: clientId }] } : clientScope(user) },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      rawText: true,
      detectedTypeLabel: true,
      createdAt: true,
      document: {
        select: { fileName: true, label: true, client: { select: { firstName: true, lastName: true } } },
      },
    },
  })
  const ranked = rankByRelevance(
    rows.map((d) => ({ d, at: d.createdAt, text: d.rawText ?? '' })),
    terms,
    perRetrieverLimit,
  )
  return {
    considered: rows.length,
    snippets: ranked.map((r) => ({
      source: 'documents' as const,
      ref: `extraction:${r.d.id}`,
      text: `${r.d.detectedTypeLabel ?? r.d.document.label ?? r.d.document.fileName ?? 'Document'} for ${r.d.document.client.firstName} ${r.d.document.client.lastName}: ${excerptAround(r.text, terms)}`,
    })),
  }
}

/** Marketing performance over the last 30 days. */
const retrieveMetrics: Retriever = async (user, _terms, { perRetrieverLimit }) => {
  const overview = await getMarketingOverview(user, marketingRange('30'))
  const snippets: RetrievalSnippet[] = [
    {
      source: 'metrics',
      ref: 'marketing:totals-30d',
      text: `Last 30 days — ${overview.totals.leads} leads (${overview.totals.leadsDeltaPct === null ? 'no prior-period comparison' : `${overview.totals.leadsDeltaPct > 0 ? '+' : ''}${overview.totals.leadsDeltaPct}% vs prior period`}), ${overview.totals.qualified} qualified, ${overview.totals.won} won, ${overview.totals.unattributed} unattributed.`,
    },
    {
      source: 'metrics',
      ref: 'marketing:ads-30d',
      text: `Ad performance (30d) — spend $${overview.ads.spend.toFixed(0)}, ${overview.ads.clicks} clicks, cost per lead ${overview.ads.costPerLead === null ? 'n/a' : `$${overview.ads.costPerLead.toFixed(2)}`}, cost per qualified ${overview.ads.costPerQualified === null ? 'n/a' : `$${overview.ads.costPerQualified.toFixed(2)}`}.`,
    },
  ]
  const topCampaigns = [...overview.campaigns].sort((a, b) => b.spend - a.spend).slice(0, 3)
  for (const c of topCampaigns) {
    if (c.spend <= 0 && c.leads === 0) continue
    snippets.push({
      source: 'metrics',
      ref: `campaign:${c.id}`,
      text: `Campaign "${c.name}" (${c.status}) — spend $${c.spend.toFixed(0)}, ${c.leads} leads, ${c.qualified} qualified, ${c.won} won.`,
    })
  }
  return { considered: 2 + overview.campaigns.length, snippets: snippets.slice(0, perRetrieverLimit) }
}

/**
 * Prior Insight rows with their human verdicts — THE learning loop. These are
 * always returned newest-first regardless of keyword match, because what the
 * org accepted or dismissed is unconditionally relevant to the next run.
 */
const retrievePastInsights: Retriever = async (user, _terms, { perRetrieverLimit }) => {
  const rows = await db.insight.findMany({
    where: { organizationId: user.organizationId, status: { in: ['ACCEPTED', 'DISMISSED'] } },
    orderBy: [{ reviewedAt: 'desc' }, { createdAt: 'desc' }],
    take: 20,
    select: {
      id: true,
      kind: true,
      title: true,
      body: true,
      status: true,
      reviewNote: true,
      outcome: true,
      reviewedBy: { select: { name: true } },
    },
  })
  return {
    considered: rows.length,
    snippets: rows.slice(0, Math.max(perRetrieverLimit, 10)).map((i) => ({
      source: 'pastInsights' as const,
      ref: `insight:${i.id}`,
      text: [
        `[${i.status}] (${i.kind}) ${i.title} — ${i.body.replace(/\s+/g, ' ').slice(0, 240)}`,
        i.reviewedBy ? `Reviewed by ${i.reviewedBy.name}.` : null,
        i.reviewNote ? `Review note: ${i.reviewNote.slice(0, 240)}` : null,
        i.outcome ? `Measured outcome: ${JSON.stringify(i.outcome).slice(0, 300)}` : null,
      ]
        .filter(Boolean)
        .join(' '),
    })),
  }
}

const RETRIEVERS: Record<RetrieverKey, Retriever> = {
  clients: retrieveClients,
  timeline: retrieveTimeline,
  notes: retrieveNotes,
  communications: retrieveCommunications,
  documents: retrieveDocuments,
  metrics: retrieveMetrics,
  pastInsights: retrievePastInsights,
}

/**
 * Runs the requested retrievers for this user's scope and returns their cited
 * snippets. Everything is take-capped, so the result is bounded no matter how
 * large the organization grows.
 */
export async function retrieveContext(
  user: SessionUser,
  query: string,
  opts: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const terms = keywordTerms(query)
  const keys = opts.retrievers ?? [
    ...DEFAULT_RETRIEVERS,
    ...(opts.clientId ? (['timeline'] as RetrieverKey[]) : []),
  ]
  const perRetrieverLimit = opts.perRetrieverLimit ?? DEFAULT_PER_RETRIEVER

  const results = await Promise.all(
    keys.map(async (key) => {
      const { considered, snippets } = await RETRIEVERS[key](user, terms, {
        perRetrieverLimit,
        clientId: opts.clientId,
      })
      return { key, considered, snippets }
    }),
  )

  return {
    snippets: results.flatMap((r) => r.snippets),
    stats: results.map((r) => ({ retriever: r.key, considered: r.considered, returned: r.snippets.length })),
  }
}
