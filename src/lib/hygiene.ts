import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { getCloseOpsConfig } from '@/lib/closeops'

/**
 * Data-hygiene monitor — the manager's daily cleanliness check.
 *
 * A set of scoped checks over the caller's client book (clientScope): each one
 * counts the live records that have drifted out of good shape (unscored, orphaned,
 * missing essentials, going stale) and surfaces a handful of examples. It rolls up
 * into a single 0-100 hygiene score so "is my CRM clean?" has one honest answer.
 *
 * The Phase 1 advance criterion this backs is "clean data hygiene in CRM and
 * dashboard" — a gating requirement, not vanity. Everything is measurement: the
 * report never mutates a record, it just shows what needs a human's attention.
 */

// ── Pure spec + scoring (tested in hygiene.test.ts) ──────────────────────────

export type HygieneSeverity = 'critical' | 'warning' | 'info'

export type HygieneCheckKey =
  | 'unscoredLive'
  | 'ownerless'
  | 'staleHot'
  | 'missingContact'
  | 'pastDueAppointments'
  | 'hotNoBrief'
  | 'longIdle'

export type HygieneCheckSpec = {
  key: HygieneCheckKey
  label: string
  description: string
  severity: HygieneSeverity
  /**
   * Relative penalty weight. Weights across all checks sum to 1, so a book that
   * fails every check as hard as possible bottoms the score out at 0.
   */
  weight: number
}

/**
 * The check catalogue, in the order they read on the page. Descriptions carry a
 * `{threshold}` / `{window}` token filled in at query time from the org's
 * close-ops config, so the copy always matches the numbers actually applied.
 */
export const HYGIENE_CHECKS: HygieneCheckSpec[] = [
  {
    key: 'staleHot',
    label: 'Stale hot leads',
    description:
      'AI probability {threshold}%+ but no activity inside the {window}-day leakage window — the deals most expensive to lose.',
    severity: 'critical',
    weight: 0.2,
  },
  {
    key: 'unscoredLive',
    label: 'Unscored live leads',
    description:
      'No AI probability-to-close yet, so the hot-leads queue can never surface them. Score them on the client record.',
    severity: 'warning',
    weight: 0.18,
  },
  {
    key: 'ownerless',
    label: 'Ownerless active clients',
    description: 'Past the new-lead stage with nobody assigned — no closer owns the next touch.',
    severity: 'critical',
    weight: 0.15,
  },
  {
    key: 'missingContact',
    label: 'Missing contact essentials',
    description: 'No email or no phone on file — unreachable through at least one channel.',
    severity: 'warning',
    weight: 0.15,
  },
  {
    key: 'pastDueAppointments',
    label: 'Past-due appointments',
    description: 'Still marked scheduled or confirmed after their start time — set an outcome or reschedule.',
    severity: 'warning',
    weight: 0.12,
  },
  {
    key: 'hotNoBrief',
    label: 'Hot leads without a Closer Brief',
    description:
      'AI probability {threshold}%+ but no AI Closer Brief has ever been generated — the call goes in cold.',
    severity: 'info',
    weight: 0.1,
  },
  {
    key: 'longIdle',
    label: 'Long-idle in stage',
    description: 'Sitting in a non-terminal stage more than twice its SLA — stuck, not progressing.',
    severity: 'info',
    weight: 0.1,
  },
]

/**
 * Penalty a single check contributes: its weight scaled by how much of the book
 * it touches, capped at the full weight (one check can never over-count the book).
 */
export function checkPenalty(weight: number, count: number, book: number): number {
  if (count <= 0 || weight <= 0) return 0
  const denom = book > 0 ? book : 1
  return weight * Math.min(count / denom, 1)
}

/**
 * Overall hygiene score, 0-100. Starts at 100 and subtracts each check's
 * count-relative-to-book penalty. Pure: give it counts and the live total.
 */
export function hygieneScore(
  counts: ReadonlyArray<{ weight: number; count: number }>,
  liveCount: number,
): number {
  const book = liveCount > 0 ? liveCount : 1
  const penalty = counts.reduce((sum, c) => sum + checkPenalty(c.weight, c.count, book), 0)
  return Math.max(0, Math.min(100, Math.round(100 - penalty * 100)))
}

export type HygieneGrade = 'clean' | 'good' | 'fair' | 'poor'

/** Score band, for the ring color and the headline verdict. */
export function scoreGrade(score: number): HygieneGrade {
  if (score >= 95) return 'clean'
  if (score >= 80) return 'good'
  if (score >= 60) return 'fair'
  return 'poor'
}

// ── Report shape ─────────────────────────────────────────────────────────────

export type HygieneSampleClient = { id: string; name: string; stage: string }

export type HygieneCheckResult = {
  key: HygieneCheckKey
  label: string
  description: string
  count: number
  severity: HygieneSeverity
  sampleClients: HygieneSampleClient[]
  /** Filtered /clients view when one genuinely matches the check, else null. */
  href: string | null
}

export type HygieneReport = {
  score: number
  grade: HygieneGrade
  /** Live, non-terminal clients in scope — the denominator for every ratio. */
  liveCount: number
  /** Sum of every check's count (records may appear under more than one). */
  totalIssues: number
  checks: HygieneCheckResult[]
  hotLeadThreshold: number
  leakageDays: number
  generatedAt: Date
}

const SAMPLE_LIMIT = 8

type SampleRow = {
  id: string
  firstName: string
  lastName: string
  currentStage: { name: string }
}

const SAMPLE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  currentStage: { select: { name: true } },
} satisfies Prisma.ClientSelect

function toSamples(rows: SampleRow[]): HygieneSampleClient[] {
  return rows.map((c) => ({
    id: c.id,
    name: `${c.firstName} ${c.lastName}`,
    stage: c.currentStage.name,
  }))
}

/** Count + a small, most-neglected-first sample for one check's `where`. */
async function countAndSample(
  where: Prisma.ClientWhereInput,
): Promise<{ count: number; samples: HygieneSampleClient[] }> {
  const [count, rows] = await Promise.all([
    db.client.count({ where }),
    db.client.findMany({
      where,
      take: SAMPLE_LIMIT,
      orderBy: { lastActivityAt: 'asc' },
      select: SAMPLE_SELECT,
    }),
  ])
  return { count, samples: toSamples(rows) }
}

/**
 * The full hygiene report over the caller's client scope. A manager sees their
 * team's book; an admin the whole org — same scope every other sales view uses.
 */
export async function getHygieneReport(user: SessionUser): Promise<HygieneReport> {
  const scope = clientScope(user)
  const config = await getCloseOpsConfig(user.organizationId)
  const now = new Date()
  const leakageCutoff = new Date(now.getTime() - config.leakageDays * 86_400_000)
  const threshold = config.hotLeadThreshold

  // Reusable predicate fragments.
  const liveStage: Prisma.ClientWhereInput['currentStage'] = { is: { isTerminal: false } }
  const live: Prisma.ClientWhereInput = { ...scope, status: 'ACTIVE', currentStage: liveStage }
  // The AI-queue universe: live, non-terminal, and not yet handed to submission.
  const queueStage: Prisma.ClientWhereInput['currentStage'] = {
    is: { isTerminal: false, category: { not: 'SUBMISSION' } },
  }
  const hotWhere: Prisma.ClientWhereInput = {
    ...scope,
    status: 'ACTIVE',
    currentStage: queueStage,
    aiCloseProbability: { gte: threshold },
  }

  // Long-idle needs per-stage cutoffs (stageEnteredAt < now - 2 × SLA), which a
  // single Prisma filter can't express against a related field — so gather the
  // SLA-bearing non-terminal stages and OR one clause per stage.
  const slaStages = await db.pipelineStage.findMany({
    where: {
      pipeline: { organizationId: user.organizationId },
      isTerminal: false,
      slaHours: { not: null },
    },
    select: { id: true, slaHours: true },
  })
  const idleClauses: Prisma.ClientWhereInput[] = slaStages.map((s) => ({
    currentStageId: s.id,
    stageEnteredAt: { lt: new Date(now.getTime() - 2 * (s.slaHours as number) * 3_600_000) },
  }))

  const [
    liveCount,
    unscoredLive,
    ownerless,
    staleHot,
    missingContact,
    pastDueAppointments,
    hotNoBrief,
    longIdle,
  ] = await Promise.all([
    db.client.count({ where: live }),
    countAndSample({ ...scope, status: 'ACTIVE', currentStage: queueStage, aiCloseProbability: null }),
    countAndSample({
      ...scope,
      status: 'ACTIVE',
      ownerId: null,
      currentStage: { is: { isTerminal: false, key: { not: 'NEW_LEAD' } } },
    }),
    countAndSample({ ...hotWhere, lastActivityAt: { lt: leakageCutoff } }),
    countAndSample({ ...live, OR: [{ email: '' }, { phone: '' }] }),
    countAndSample({
      ...live,
      appointments: {
        some: { status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { lt: now } },
      },
    }),
    countAndSample({ ...hotWhere, closerBriefs: { none: {} } }),
    idleClauses.length > 0
      ? countAndSample({ ...scope, status: 'ACTIVE', OR: idleClauses })
      : Promise.resolve({ count: 0, samples: [] as HygieneSampleClient[] }),
  ])

  const byKey: Record<HygieneCheckKey, { count: number; samples: HygieneSampleClient[] }> = {
    unscoredLive,
    ownerless,
    staleHot,
    missingContact,
    pastDueAppointments,
    hotNoBrief,
    longIdle,
  }

  // Only checks with a genuinely matching /clients filter get a "view all" link;
  // the time-based checks map to the stalest-activity-first sort, nothing fakes one.
  const hrefFor: Partial<Record<HygieneCheckKey, string>> = {
    staleHot: '/clients?sort=oldest',
    longIdle: '/clients?sort=oldest',
  }

  const checks: HygieneCheckResult[] = HYGIENE_CHECKS.map((spec) => {
    const found = byKey[spec.key]
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description
        .replace('{threshold}', String(threshold))
        .replace('{window}', String(config.leakageDays)),
      count: found.count,
      severity: spec.severity,
      sampleClients: found.samples,
      href: found.count > 0 ? (hrefFor[spec.key] ?? null) : null,
    }
  })

  const score = hygieneScore(
    HYGIENE_CHECKS.map((s) => ({ weight: s.weight, count: byKey[s.key].count })),
    liveCount,
  )

  return {
    score,
    grade: scoreGrade(score),
    liveCount,
    totalIssues: checks.reduce((sum, c) => sum + c.count, 0),
    checks,
    hotLeadThreshold: threshold,
    leakageDays: config.leakageDays,
    generatedAt: now,
  }
}
