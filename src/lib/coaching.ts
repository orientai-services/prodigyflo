import 'server-only'
import { redirect } from 'next/navigation'
import type { CoachingKind, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import {
  ForbiddenError,
  clientScope,
  requireUser,
  userScope,
  type SessionUser,
} from '@/lib/rbac'

/**
 * Coaching & call QA, plus the access rules for the Sales command section.
 *
 * Visibility model (deliberately simple and safe):
 *  - Everyone sees notes they wrote and notes written about them.
 *  - Managers (`users:read` plus team-level analytics and up — see canCoach)
 *    additionally see notes about any user inside their `userScope` — the same
 *    reach as every roster view.
 *  - Everything is pinned to the caller's organization.
 */

// ── Sales-section access ─────────────────────────────────────────────────────

export type SalesLevel = 'org' | 'region' | 'team' | 'self'

/**
 * Like reporting.analyticsLevel, but loosened one notch: a closer holding
 * `analytics:self` gets in too. Data is always narrowed by `clientScope`, so
 * the level only labels how wide that scope already is.
 */
export function salesLevel(user: Pick<SessionUser, 'permissions'>): SalesLevel | null {
  if (user.permissions.has('analytics:org')) return 'org'
  if (user.permissions.has('analytics:region')) return 'region'
  if (user.permissions.has('analytics:team')) return 'team'
  if (user.permissions.has('analytics:self')) return 'self'
  return null
}

export const SALES_LEVEL_LABEL: Record<SalesLevel, string> = {
  org: 'entire organization',
  region: 'your region',
  team: 'your team',
  self: 'your own pipeline',
}

/** Page gate for /sales/**: redirects to /forbidden without any analytics grant. */
export async function requireSalesAccess(): Promise<{ user: SessionUser; level: SalesLevel }> {
  const user = await requireUser()
  const level = salesLevel(user)
  if (!level) redirect('/forbidden')
  return { user, level }
}

// ── Pure display logic (tested in coaching.test.ts) ──────────────────────────

export type ProbabilityTier = 'scorching' | 'hot' | 'warm'

/** Color grade for an AI probability-to-close badge. */
export function probabilityTier(probability: number): ProbabilityTier {
  if (probability >= 95) return 'scorching'
  if (probability >= 90) return 'hot'
  return 'warm'
}

export type BriefStatus = 'none' | 'generated' | 'viewed'

/** Chip state for the latest AI Closer Brief on a lead. */
export function briefStatus(generatedAt: Date | null, viewedAt: Date | null): BriefStatus {
  if (viewedAt) return 'viewed'
  if (generatedAt) return 'generated'
  return 'none'
}

export type CoachingRollup = {
  subjectId: string
  total: number
  qaCount: number
  /** Average CALL_QA score (1-10), one decimal. Null until a scored QA exists. */
  qaAvg: number | null
  /** Notes of any kind created this calendar month. */
  monthCount: number
}

type RollupRow = {
  subjectId: string
  kind: CoachingKind
  score: number | null
  createdAt: Date
}

/** Per-closer coaching summary from raw note rows. */
export function coachingRollups(rows: RollupRow[], now = new Date()): Map<string, CoachingRollup> {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const sums = new Map<string, number>()
  const out = new Map<string, CoachingRollup>()
  for (const row of rows) {
    const acc =
      out.get(row.subjectId) ??
      { subjectId: row.subjectId, total: 0, qaCount: 0, qaAvg: null, monthCount: 0 }
    acc.total += 1
    if (row.createdAt >= monthStart) acc.monthCount += 1
    if (row.kind === 'CALL_QA' && typeof row.score === 'number') {
      sums.set(row.subjectId, (sums.get(row.subjectId) ?? 0) + row.score)
      acc.qaCount += 1
    }
    out.set(row.subjectId, acc)
  }
  for (const acc of out.values()) {
    const qaSum = sums.get(acc.subjectId)
    acc.qaAvg =
      acc.qaCount > 0 && qaSum !== undefined ? Math.round((qaSum / acc.qaCount) * 10) / 10 : null
  }
  return out
}

/**
 * True when the user may write coaching notes and see their team's notes.
 *
 * Coaching is a MANAGEMENT capability, not an analytics one: it requires the
 * roster permission (`users:read` — sales managers and up) on top of
 * team-or-wider analytics. Analytics breadth alone (e.g. MARKETING's
 * `analytics:org`) must never grant Call-QA authorship or org-wide note reads.
 */
export function canCoach(user: Pick<SessionUser, 'permissions'>): boolean {
  return (
    user.permissions.has('users:read') &&
    (user.permissions.has('analytics:team') ||
      user.permissions.has('analytics:region') ||
      user.permissions.has('analytics:org'))
  )
}

/** Which coaching notes this user may read. Always org-pinned. */
export function coachingVisibleWhere(user: SessionUser): Prisma.CoachingNoteWhereInput {
  const own: Prisma.CoachingNoteWhereInput[] = [{ subjectId: user.id }, { authorId: user.id }]
  return {
    organizationId: user.organizationId,
    OR: canCoach(user) ? [...own, { subject: userScope(user) }] : own,
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

export type CoachingNoteRow = {
  id: string
  kind: CoachingKind
  score: number | null
  strengths: string | null
  improvements: string | null
  body: string
  createdAt: Date
  subject: { id: string; name: string }
  author: { id: string; name: string }
  client: { id: string; firstName: string; lastName: string } | null
}

export async function listCoachingNotes(user: SessionUser, limit = 100): Promise<CoachingNoteRow[]> {
  return db.coachingNote.findMany({
    where: coachingVisibleWhere(user),
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      kind: true,
      score: true,
      strengths: true,
      improvements: true,
      body: true,
      createdAt: true,
      subject: { select: { id: true, name: true } },
      author: { select: { id: true, name: true } },
      client: { select: { id: true, firstName: true, lastName: true } },
    },
  })
}

/** Rollups across everything visible — not capped by the feed's page size. */
export async function getCoachingRollups(user: SessionUser): Promise<Map<string, CoachingRollup>> {
  const rows = await db.coachingNote.findMany({
    where: coachingVisibleWhere(user),
    select: { subjectId: true, kind: true, score: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  })
  return coachingRollups(rows)
}

export type CoachableCloser = { id: string; name: string; teamName: string | null }

/** Active closers inside the caller's scope — the subject picker for new notes. */
export async function listCoachableClosers(user: SessionUser): Promise<CoachableCloser[]> {
  const closers = await db.user.findMany({
    where: { AND: [userScope(user), { role: { key: 'CLOSER' }, isActive: true }] },
    select: { id: true, name: true, team: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  return closers.map((c) => ({ id: c.id, name: c.name, teamName: c.team?.name ?? null }))
}

export type CoachingClientOption = { id: string; name: string }

/** Recently-active clients in scope, for optionally pinning a note to a deal. */
export async function listRecentClientsForCoaching(
  user: SessionUser,
  limit = 30,
): Promise<CoachingClientOption[]> {
  const clients = await db.client.findMany({
    where: { ...clientScope(user), status: 'ACTIVE' },
    orderBy: { lastActivityAt: 'desc' },
    take: limit,
    select: { id: true, firstName: true, lastName: true },
  })
  return clients.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}` }))
}

// ── Mutations ────────────────────────────────────────────────────────────────

export type CreateCoachingNoteInput = {
  subjectId: string
  kind: CoachingKind
  /** Required 1-10 for CALL_QA; ignored for ONE_ON_ONE. */
  score?: number | null
  strengths?: string | null
  improvements?: string | null
  body: string
  clientId?: string | null
}

export class CoachingError extends Error {}

export async function createCoachingNote(
  user: SessionUser,
  input: CreateCoachingNoteInput,
): Promise<{ id: string }> {
  if (!canCoach(user)) {
    throw new ForbiddenError('Management access (roster plus team-level analytics) is required to coach.')
  }

  const body = input.body?.trim()
  if (!body) throw new CoachingError('Write the note body — that is the coaching.')

  const subject = await db.user.findFirst({
    where: { AND: [userScope(user), { id: input.subjectId, isActive: true, deletedAt: null }] },
    select: { id: true, name: true },
  })
  if (!subject) throw new CoachingError('That closer is not in your scope.')

  let score: number | null = null
  if (input.kind === 'CALL_QA') {
    const s = Number(input.score)
    if (!Number.isInteger(s) || s < 1 || s > 10) {
      throw new CoachingError('Call QA needs a score from 1 to 10.')
    }
    score = s
  }

  let clientId: string | null = null
  if (input.clientId) {
    const client = await db.client.findFirst({
      where: { AND: [clientScope(user), { id: input.clientId }] },
      select: { id: true },
    })
    if (!client) throw new CoachingError('That client is not in your scope.')
    clientId = client.id
  }

  const note = await db.coachingNote.create({
    data: {
      organizationId: user.organizationId,
      subjectId: subject.id,
      authorId: user.id,
      kind: input.kind,
      score,
      strengths: input.strengths?.trim() || null,
      improvements: input.improvements?.trim() || null,
      body,
      clientId,
    },
    select: { id: true },
  })

  await recordAudit(user, {
    action: 'coaching.note_created',
    entityType: 'CoachingNote',
    entityId: note.id,
    summary:
      input.kind === 'CALL_QA'
        ? `Call QA for ${subject.name} — score ${score}/10`
        : `1-on-1 coaching note for ${subject.name}`,
  })

  return note
}
