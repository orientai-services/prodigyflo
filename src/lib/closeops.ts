import 'server-only'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { mergeOrgSettings } from '@/lib/org-settings'
import { ForbiddenError, clientScope, type SessionUser } from '@/lib/rbac'

/**
 * Close-rate operations — the Phase 1/2/3 operating model.
 *
 * Everything here is measurement and configuration. The AI probability-to-close
 * score on Client is a PRIORITIZATION signal only: it orders the hot-leads
 * queue and feeds the dashboards, and a human always makes the qualification,
 * eligibility, and close decisions.
 */

// ── Phase definitions (from the operating-model docs) ────────────────────────

export type OpsPhaseDef = {
  phase: 1 | 2 | 3
  name: string
  objective: string
  /** Default hot-lead AI-probability threshold for the phase. */
  hotLeadThreshold: number
  targets: {
    closeRatePct: number
    avgAiProbabilityOnWonPct: number
    monthlyRevenueLow: number
    monthlyRevenueHigh: number
    leadLeakageMaxPct: number
  }
  focusAreas: string[]
  advanceCriteria: string[]
}

export const OPS_PHASES: OpsPhaseDef[] = [
  {
    phase: 1,
    name: '35%+ close-rate operations',
    objective:
      'Stabilize and optimize the closer team using AI Closer Briefs, probability-to-close scoring, and a disciplined daily rhythm.',
    hotLeadThreshold: 80,
    targets: {
      closeRatePct: 35,
      avgAiProbabilityOnWonPct: 82,
      monthlyRevenueLow: 900_000,
      monthlyRevenueHigh: 1_200_000,
      leadLeakageMaxPct: 5,
    },
    focusAreas: [
      'Consistent use of AI Closer Briefs on every call',
      'Strict adherence to the 5-step funnel process',
      'Daily dashboard review (hot leads at 80%+)',
      'Mandatory morning huddles + end-of-day wraps',
      'Weekly 1-on-1 coaching + call QA',
    ],
    advanceCriteria: [
      'Close rate at or above 35% for 60+ days',
      'Strong AI Brief adoption across all closers',
      'Clean data hygiene in CRM and dashboard',
      'Stable daily operating rhythm',
    ],
  },
  {
    phase: 2,
    name: 'Path to 60%+ close rate',
    objective:
      'Elevate close rates to a stable 55-62%+ on qualified leads by tightening qualification, structured pre-call nurture, and higher coaching intensity.',
    hotLeadThreshold: 75,
    targets: {
      closeRatePct: 55,
      avgAiProbabilityOnWonPct: 82,
      monthlyRevenueLow: 1_400_000,
      monthlyRevenueHigh: 1_800_000,
      leadLeakageMaxPct: 5,
    },
    focusAreas: [
      'Work 75%+ AI-probability leads only',
      'Mandatory pre-call nurture (personalized video)',
      'Lead Qualifier reviews every 75%+ lead',
      'AI Brief usage scored per closer',
      'Gamification tied to AI accuracy',
    ],
    advanceCriteria: [
      'Close rate at 55-60%+ for 60+ days',
      'Qualifier reviewing every hot lead',
      'Pre-call nurture running on every booked call',
      'Full gamification + process-adherence tracking',
    ],
  },
  {
    phase: 3,
    name: 'Path to 90% close rate',
    objective:
      'Shift to a low-volume, high-touch confirmation operation: extreme lead selectivity, heavy automation, closers as Confirmation Specialists.',
    hotLeadThreshold: 95,
    targets: {
      closeRatePct: 85,
      avgAiProbabilityOnWonPct: 95,
      monthlyRevenueLow: 1_400_000,
      monthlyRevenueHigh: 1_800_000,
      leadLeakageMaxPct: 3,
    },
    focusAreas: [
      'Accept 95%+ AI-probability leads only',
      'AI + pre-sell content handles most education before the call',
      'Closers operate as Confirmation Specialists',
      'Success-based or tiered pricing',
      'Lower volume, much higher margin per deal',
    ],
    advanceCriteria: ['This is the end-state model — refine, do not advance'],
  },
]

export function phaseDef(phase: number): OpsPhaseDef {
  return OPS_PHASES.find((p) => p.phase === phase) ?? OPS_PHASES[0]
}

// ── Configuration (Organization.settings.closeOps) ───────────────────────────

export type CloseOpsConfig = {
  phase: 1 | 2 | 3
  /** Hot-lead threshold in effect (phase default unless pinned). */
  hotLeadThreshold: number
  /** Days without activity before a live lead counts as leaking. */
  leakageDays: number
}

export async function getCloseOpsConfig(organizationId: string): Promise<CloseOpsConfig> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  })
  const raw = (org?.settings as Record<string, unknown> | null)?.closeOps as
    | Partial<CloseOpsConfig>
    | undefined
  const phase = raw?.phase === 2 || raw?.phase === 3 ? raw.phase : 1
  const def = phaseDef(phase)
  const threshold = Number(raw?.hotLeadThreshold)
  const leakage = Number(raw?.leakageDays)
  return {
    phase,
    hotLeadThreshold:
      Number.isFinite(threshold) && threshold >= 50 && threshold <= 100 ? threshold : def.hotLeadThreshold,
    leakageDays: Number.isFinite(leakage) && leakage >= 1 && leakage <= 30 ? leakage : 7,
  }
}

export async function updateCloseOpsConfig(
  user: SessionUser,
  patch: Partial<CloseOpsConfig>,
): Promise<CloseOpsConfig> {
  if (!user.permissions.has('org:manage')) throw new ForbiddenError('org:manage required')
  const current = await getCloseOpsConfig(user.organizationId)
  const next: CloseOpsConfig = {
    phase: patch.phase === 1 || patch.phase === 2 || patch.phase === 3 ? patch.phase : current.phase,
    hotLeadThreshold: current.hotLeadThreshold,
    leakageDays: current.leakageDays,
  }
  // Changing phase resets the threshold to the new phase's default unless the
  // patch pins one explicitly.
  if (patch.phase && patch.phase !== current.phase) next.hotLeadThreshold = phaseDef(patch.phase).hotLeadThreshold
  if (typeof patch.hotLeadThreshold === 'number' && patch.hotLeadThreshold >= 50 && patch.hotLeadThreshold <= 100) {
    next.hotLeadThreshold = Math.round(patch.hotLeadThreshold)
  }
  if (typeof patch.leakageDays === 'number' && patch.leakageDays >= 1 && patch.leakageDays <= 30) {
    next.leakageDays = Math.round(patch.leakageDays)
  }

  // Atomic partial merge — concurrent writers of other settings subkeys (e.g.
  // the digest send guard) cannot be lost to a whole-JSON replace.
  await mergeOrgSettings(user.organizationId, 'closeOps', next)
  await recordAudit(user, {
    action: 'closeops.config_updated',
    entityType: 'Organization',
    entityId: user.organizationId,
    summary: `Close-rate ops set to Phase ${next.phase} (hot-lead threshold ${next.hotLeadThreshold}%, leakage window ${next.leakageDays}d)`,
  })
  return next
}

// ── Measurement ──────────────────────────────────────────────────────────────

export type CloseOpsMetrics = {
  rangeFrom: Date
  /** Won / (won + lost) among clients that reached QUALIFIED. Null until sample exists. */
  closeRatePct: number | null
  qualifiedWon: number
  qualifiedLost: number
  /** Average aiCloseProbability across deals won in the range (scored clients only). */
  avgAiProbabilityOnWonPct: number | null
  /** Deal value won this calendar month. */
  monthlyRevenue: number
  /** Live, non-terminal clients with no activity inside the leakage window. */
  leakingCount: number
  liveCount: number
  leadLeakagePct: number | null
  /** Calls in range whose client had a viewed brief generated before the call. */
  briefAdoptionPct: number | null
  callsWithBrief: number
  callsTotal: number
  hotLeadCount: number
}

/**
 * The five numbers the phase dashboards run on, computed over the caller's
 * client scope (a manager sees their team, an admin the org).
 */
export async function getCloseOpsMetrics(
  user: SessionUser,
  config: CloseOpsConfig,
  days = 90,
): Promise<CloseOpsMetrics> {
  const scope = clientScope(user)
  const rangeFrom = new Date(Date.now() - days * 86_400_000)
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const leakageCutoff = new Date(Date.now() - config.leakageDays * 86_400_000)

  const [outcomes, wonScored, monthWon, live, leaking, calls, hotLeadCount] = await Promise.all([
    // Terminal outcomes (in range) among clients that ever reached QUALIFIED.
    db.client.findMany({
      where: {
        ...scope,
        stageHistory: { some: { toKey: 'QUALIFIED' } },
        currentStage: { key: { in: ['CLOSED_WON', 'CLOSED_LOST'] } },
        stageEnteredAt: { gte: rangeFrom },
      },
      select: { currentStage: { select: { key: true } } },
    }),
    db.client.findMany({
      where: {
        ...scope,
        aiCloseProbability: { not: null },
        deal: { is: { status: 'WON', wonAt: { gte: rangeFrom } } },
      },
      select: { aiCloseProbability: true },
    }),
    db.deal.aggregate({
      where: { status: 'WON', wonAt: { gte: monthStart }, client: scope },
      _sum: { value: true },
    }),
    db.client.count({
      where: { ...scope, status: 'ACTIVE', currentStage: { isTerminal: false } },
    }),
    db.client.count({
      where: {
        ...scope,
        status: 'ACTIVE',
        currentStage: { isTerminal: false },
        lastActivityAt: { lt: leakageCutoff },
      },
    }),
    db.communication.findMany({
      where: { channel: 'CALL', occurredAt: { gte: rangeFrom }, client: scope },
      select: { occurredAt: true, clientId: true },
    }),
    db.client.count({
      where: {
        ...scope,
        status: 'ACTIVE',
        currentStage: { isTerminal: false, category: { not: 'SUBMISSION' } },
        aiCloseProbability: { gte: config.hotLeadThreshold },
      },
    }),
  ])

  const qualifiedWon = outcomes.filter((c) => c.currentStage.key === 'CLOSED_WON').length
  const qualifiedLost = outcomes.length - qualifiedWon
  const decided = qualifiedWon + qualifiedLost

  // Brief adoption: for each call, was there a viewed brief generated earlier?
  let callsWithBrief = 0
  if (calls.length > 0) {
    const briefs = await db.closerBrief.findMany({
      where: {
        organizationId: user.organizationId,
        clientId: { in: [...new Set(calls.map((c) => c.clientId))] },
        viewedAt: { not: null },
      },
      select: { clientId: true, viewedAt: true },
    })
    // Adoption means the closer actually READ the brief before the call — so the
    // earliest VIEW time is what must precede the call, not when it was generated.
    const earliestView = new Map<string, number>()
    for (const b of briefs) {
      if (!b.viewedAt) continue
      const t = b.viewedAt.getTime()
      const prev = earliestView.get(b.clientId)
      if (prev === undefined || t < prev) earliestView.set(b.clientId, t)
    }
    callsWithBrief = calls.filter((c) => {
      const t = earliestView.get(c.clientId)
      return t !== undefined && t <= c.occurredAt.getTime()
    }).length
  }

  const probs = wonScored
    .map((c) => c.aiCloseProbability)
    .filter((p): p is number => typeof p === 'number')

  return {
    rangeFrom,
    closeRatePct: decided > 0 ? Math.round((qualifiedWon / decided) * 1000) / 10 : null,
    qualifiedWon,
    qualifiedLost,
    avgAiProbabilityOnWonPct:
      probs.length > 0 ? Math.round((probs.reduce((a, b) => a + b, 0) / probs.length) * 10) / 10 : null,
    monthlyRevenue: Number(monthWon._sum.value ?? 0),
    leakingCount: leaking,
    liveCount: live,
    leadLeakagePct: live > 0 ? Math.round((leaking / live) * 1000) / 10 : null,
    briefAdoptionPct: calls.length > 0 ? Math.round((callsWithBrief / calls.length) * 1000) / 10 : null,
    callsWithBrief,
    callsTotal: calls.length,
    hotLeadCount,
  }
}

export type PhaseCheck = { label: string; actual: string; target: string; met: boolean | null }

/**
 * Target-vs-actual rows for the current phase. `met: null` means there is not
 * yet enough data to judge — shown as "measuring", never as a failure.
 */
export function evaluatePhase(def: OpsPhaseDef, m: CloseOpsMetrics): PhaseCheck[] {
  const t = def.targets
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  return [
    {
      label: 'Close rate on qualified leads',
      actual: m.closeRatePct === null ? 'no decided leads yet' : `${m.closeRatePct}%`,
      target: `${t.closeRatePct}%+`,
      met: m.closeRatePct === null ? null : m.closeRatePct >= t.closeRatePct,
    },
    {
      label: 'Avg AI probability on closed deals',
      actual: m.avgAiProbabilityOnWonPct === null ? 'no scored wins yet' : `${m.avgAiProbabilityOnWonPct}%`,
      target: `>${t.avgAiProbabilityOnWonPct}%`,
      met: m.avgAiProbabilityOnWonPct === null ? null : m.avgAiProbabilityOnWonPct > t.avgAiProbabilityOnWonPct,
    },
    {
      label: 'Team monthly revenue',
      actual: money(m.monthlyRevenue),
      target: `${money(t.monthlyRevenueLow)} – ${money(t.monthlyRevenueHigh)}`,
      met: m.monthlyRevenue >= t.monthlyRevenueLow,
    },
    {
      label: 'Lead leakage',
      actual: m.leadLeakagePct === null ? 'no live leads' : `${m.leadLeakagePct}%`,
      target: `<${t.leadLeakageMaxPct}%`,
      met: m.leadLeakagePct === null ? null : m.leadLeakagePct < t.leadLeakageMaxPct,
    },
    {
      label: 'AI Brief adoption on calls',
      actual: m.briefAdoptionPct === null ? 'no calls in range' : `${m.briefAdoptionPct}%`,
      target: 'every call',
      met: m.briefAdoptionPct === null ? null : m.briefAdoptionPct >= 80,
    },
  ]
}

// ── Hot leads ────────────────────────────────────────────────────────────────

export type HotLead = {
  id: string
  firstName: string
  lastName: string
  aiCloseProbability: number
  aiCloseProbabilityAt: Date | null
  stageName: string
  stageKey: string
  ownerName: string | null
  lastActivityAt: Date
  estimatedValue: number | null
  lastBriefViewedAt: Date | null
  lastBriefGeneratedAt: Date | null
}

/**
 * The call queue: scored live leads at/above the threshold, hottest first.
 * Submission-stage clients are excluded — once a deal is with CYS or the
 * attorney the next touch is a status update, not a closing call.
 */
export async function getHotLeads(
  user: SessionUser,
  config: CloseOpsConfig,
  limit = 100,
): Promise<HotLead[]> {
  const rows = await db.client.findMany({
    where: {
      ...clientScope(user),
      status: 'ACTIVE',
      currentStage: { isTerminal: false, category: { not: 'SUBMISSION' } },
      aiCloseProbability: { gte: config.hotLeadThreshold },
    },
    orderBy: [{ aiCloseProbability: 'desc' }, { lastActivityAt: 'asc' }],
    take: limit,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      aiCloseProbability: true,
      aiCloseProbabilityAt: true,
      lastActivityAt: true,
      estimatedValue: true,
      currentStage: { select: { name: true, key: true } },
      owner: { select: { name: true } },
      closerBriefs: {
        orderBy: { generatedAt: 'desc' },
        take: 1,
        select: { generatedAt: true, viewedAt: true },
      },
    },
  })
  return rows.map((c) => ({
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    aiCloseProbability: c.aiCloseProbability ?? 0,
    aiCloseProbabilityAt: c.aiCloseProbabilityAt,
    stageName: c.currentStage.name,
    stageKey: c.currentStage.key,
    ownerName: c.owner?.name ?? null,
    lastActivityAt: c.lastActivityAt,
    estimatedValue: c.estimatedValue === null ? null : Number(c.estimatedValue),
    lastBriefViewedAt: c.closerBriefs[0]?.viewedAt ?? null,
    lastBriefGeneratedAt: c.closerBriefs[0]?.generatedAt ?? null,
  }))
}
