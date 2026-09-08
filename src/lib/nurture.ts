import 'server-only'
import type { NurtureKind, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { can, clientScope, ForbiddenError, type SessionUser } from '@/lib/rbac'
import { getCloseOpsConfig } from '@/lib/closeops'

/**
 * Pre-call nurture (Phase 2: mandatory personalized video before the closing
 * call). A NurtureTouch records that a closer SENT something personal (video,
 * email, SMS, call prep); `confirmedAt` records that the client acknowledged
 * or viewed it. The engine only tracks the touch — a human always sends the
 * content and a human always confirms receipt.
 */

// ── Pure status logic (tested in nurture.test.ts) ────────────────────────────

export type NurtureStatus = 'none' | 'sent' | 'confirmed'

/** Roll a client's touches into one status: any confirmed touch wins. */
export function nurtureStatus(
  touches: ReadonlyArray<{ confirmedAt: Date | null }>,
): NurtureStatus {
  if (touches.some((t) => t.confirmedAt !== null)) return 'confirmed'
  if (touches.length > 0) return 'sent'
  return 'none'
}

/** Nurture links must be real https URLs — nothing else is accepted. */
export function isValidNurtureUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.hostname.length > 0
}

export const NURTURE_KIND_LABEL: Record<NurtureKind, string> = {
  VIDEO: 'Personalized video',
  EMAIL: 'Email',
  SMS: 'Text message',
  CALL_PREP: 'Call prep',
}

// ── Queue ────────────────────────────────────────────────────────────────────

export type NurtureQueueRow = {
  clientId: string
  firstName: string
  lastName: string
  ownerName: string | null
  aiCloseProbability: number | null
  /** True when the probability clears the org hot-lead threshold. */
  isHot: boolean
  /** Next SCHEDULED/CONFIRMED appointment inside the window, if any. */
  appointmentAt: Date | null
  appointmentTimezone: string | null
  status: Exclude<NurtureStatus, 'confirmed'>
  latestTouch: {
    id: string
    kind: NurtureKind
    url: string | null
    sentAt: Date
  } | null
}

export type NurtureQueue = {
  rows: NurtureQueueRow[]
  hotLeadThreshold: number
  /** Touches confirmed in the past 7 days across the caller's scope. */
  confirmedThisWeek: number
}

const QUEUE_WINDOW_DAYS = 7

/**
 * Who still needs pre-call nurture: clients with an upcoming appointment in
 * the next 7 days, plus hot leads at/above the org threshold — minus anyone
 * whose nurture is already confirmed. Soonest appointment first, then the
 * hottest unbooked leads.
 */
export async function getNurtureQueue(user: SessionUser): Promise<NurtureQueue> {
  const config = await getCloseOpsConfig(user.organizationId)
  const now = new Date()
  const windowEnd = new Date(now.getTime() + QUEUE_WINDOW_DAYS * 86_400_000)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)

  const upcomingAppointment: Prisma.AppointmentWhereInput = {
    status: { in: ['SCHEDULED', 'CONFIRMED'] },
    startsAt: { gte: now, lte: windowEnd },
  }

  const [clients, confirmedThisWeek] = await Promise.all([
    db.client.findMany({
      where: {
        AND: [
          clientScope(user),
          {
            status: 'ACTIVE',
            OR: [
              { appointments: { some: upcomingAppointment } },
              {
                // Mirrors getHotLeads: submission-stage clients are out of the
                // call queue, so they need no pre-call nurture either.
                currentStage: { isTerminal: false, category: { not: 'SUBMISSION' } },
                aiCloseProbability: { gte: config.hotLeadThreshold },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        aiCloseProbability: true,
        owner: { select: { name: true } },
        appointments: {
          where: upcomingAppointment,
          orderBy: { startsAt: 'asc' },
          take: 1,
          select: { startsAt: true, timezone: true },
        },
        nurtureTouches: {
          orderBy: { sentAt: 'desc' },
          select: { id: true, kind: true, url: true, sentAt: true, confirmedAt: true },
        },
      },
    }),
    db.nurtureTouch.count({
      where: {
        organizationId: user.organizationId,
        confirmedAt: { gte: weekAgo },
        client: clientScope(user),
      },
    }),
  ])

  const rows: NurtureQueueRow[] = []
  for (const c of clients) {
    const status = nurtureStatus(c.nurtureTouches)
    if (status === 'confirmed') continue
    const appt = c.appointments[0] ?? null
    const latest = c.nurtureTouches[0] ?? null
    rows.push({
      clientId: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      ownerName: c.owner?.name ?? null,
      aiCloseProbability: c.aiCloseProbability,
      isHot:
        typeof c.aiCloseProbability === 'number' &&
        c.aiCloseProbability >= config.hotLeadThreshold,
      appointmentAt: appt?.startsAt ?? null,
      appointmentTimezone: appt?.timezone ?? null,
      status,
      latestTouch: latest
        ? { id: latest.id, kind: latest.kind, url: latest.url, sentAt: latest.sentAt }
        : null,
    })
  }

  rows.sort((a, b) => {
    if (a.appointmentAt && b.appointmentAt) {
      return a.appointmentAt.getTime() - b.appointmentAt.getTime()
    }
    if (a.appointmentAt) return -1
    if (b.appointmentAt) return 1
    return (b.aiCloseProbability ?? 0) - (a.aiCloseProbability ?? 0)
  })

  return { rows, hotLeadThreshold: config.hotLeadThreshold, confirmedThisWeek }
}

// ── Mutations ────────────────────────────────────────────────────────────────

export class NurtureError extends Error {}

/**
 * Staff gate for the internal nurture mutations. A touch records that a human
 * SENT something to a client, so it takes the same capability as logging a
 * call (`communications:send`, see logCall in call-log.ts). Portal CLIENT
 * sessions are rejected outright — their only path is
 * confirmNurtureTouchFromPortal, which can never forge a touch nor reach the
 * internal CALL_PREP kind.
 */
function requireNurtureStaff(user: SessionUser): void {
  if (user.role === 'CLIENT' || !can(user, 'communications:send')) {
    throw new ForbiddenError('You do not have permission to manage nurture touches.')
  }
}

export type RecordNurtureTouchInput = {
  clientId: string
  kind: NurtureKind
  url?: string | null
  note?: string | null
}

/** Log that a personalized touch went out. Staff-only; scope-checked; audited. */
export async function recordNurtureTouch(
  user: SessionUser,
  input: RecordNurtureTouchInput,
): Promise<{ id: string }> {
  requireNurtureStaff(user)

  const url = input.url?.trim() || null
  if (url && !isValidNurtureUrl(url)) {
    throw new NurtureError('The link must be a valid https:// URL.')
  }

  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: input.clientId }] },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!client) throw new NurtureError('That client is not in your scope.')

  const touch = await db.nurtureTouch.create({
    data: {
      organizationId: user.organizationId,
      clientId: client.id,
      senderId: user.id,
      kind: input.kind,
      url,
      note: input.note?.trim() || null,
    },
    select: { id: true },
  })

  await recordAudit(user, {
    action: 'nurture.sent',
    entityType: 'NurtureTouch',
    entityId: touch.id,
    summary: `${NURTURE_KIND_LABEL[input.kind]} nurture sent to ${client.firstName} ${client.lastName}`,
  })

  return touch
}

/** Mark a sent touch as confirmed by the client. Staff-only; scope-checked; audited. */
export async function confirmNurtureTouch(
  user: SessionUser,
  touchId: string,
): Promise<{ id: string; clientId: string }> {
  requireNurtureStaff(user)

  const touch = await db.nurtureTouch.findFirst({
    where: {
      id: touchId,
      organizationId: user.organizationId,
      client: clientScope(user),
    },
    select: {
      id: true,
      confirmedAt: true,
      kind: true,
      clientId: true,
      client: { select: { firstName: true, lastName: true } },
    },
  })
  if (!touch) throw new NurtureError('That nurture touch is not in your scope.')
  if (touch.confirmedAt) throw new NurtureError('That touch is already confirmed.')

  await db.nurtureTouch.update({
    where: { id: touch.id },
    data: { confirmedAt: new Date() },
  })

  await recordAudit(user, {
    action: 'nurture.confirmed',
    entityType: 'NurtureTouch',
    entityId: touch.id,
    summary: `${NURTURE_KIND_LABEL[touch.kind]} nurture confirmed by ${touch.client.firstName} ${touch.client.lastName}`,
  })

  return { id: touch.id, clientId: touch.clientId }
}

// ── Portal (client-side engagement) ──────────────────────────────────────────

/**
 * Pure ownership gate for a portal confirmation: only a CLIENT session whose
 * linked portal client row is the touch's client may confirm it. Never trust
 * a touch id from the wire — this runs on the DB row, after scoping.
 */
export function portalCanConfirmTouch(
  user: { role: string; portalClientId: string | null },
  touch: { clientId: string },
): boolean {
  return (
    user.role === 'CLIENT' &&
    user.portalClientId !== null &&
    user.portalClientId === touch.clientId
  )
}

/** First name to show the client for a touch's sender; never an empty string. */
export function senderFirstName(name: string | null | undefined, fallback = 'Your advisor'): string {
  const first = name?.trim().split(/\s+/)[0]
  return first || fallback
}

/** Client-safe kind labels — internal vocabulary ("call prep") never crosses. */
export const PORTAL_NURTURE_KIND_LABEL: Record<NurtureKind, string> = {
  VIDEO: 'Personal video',
  EMAIL: 'Email',
  SMS: 'Text message',
  CALL_PREP: 'Call notes',
}

/** Kinds a client sees in their portal — things actually SENT to them. Call
 * prep is internal closer homework and stays off the portal. */
export const PORTAL_VISIBLE_NURTURE_KINDS: NurtureKind[] = ['VIDEO', 'EMAIL', 'SMS']

export type PortalNurtureTouch = {
  id: string
  kind: NurtureKind
  url: string | null
  note: string | null
  sentAt: Date
  confirmedAt: Date | null
  senderFirstName: string
}

/**
 * The touches a client sees on their portal home, newest first. Takes an
 * already-verified portal clientId (from requirePortalClient) — never a raw id.
 */
export async function loadPortalNurtureTouches(clientId: string): Promise<PortalNurtureTouch[]> {
  const touches = await db.nurtureTouch.findMany({
    where: { clientId, kind: { in: PORTAL_VISIBLE_NURTURE_KINDS } },
    orderBy: { sentAt: 'desc' },
    take: 20,
    select: {
      id: true,
      kind: true,
      url: true,
      note: true,
      sentAt: true,
      confirmedAt: true,
      sender: { select: { name: true } },
    },
  })

  return touches.map((t) => ({
    id: t.id,
    kind: t.kind,
    url: t.url,
    note: t.note,
    sentAt: t.sentAt,
    confirmedAt: t.confirmedAt,
    senderFirstName: senderFirstName(t.sender?.name),
  }))
}

/**
 * A portal client opening what their advisor sent — the REAL confirmation.
 * Validates the touch belongs to THIS session's portal client (scope + explicit
 * ownership check — the id from the wire is never trusted), stamps confirmedAt
 * once (idempotent: re-opening never errors), audits with the portal client as
 * actor, and rings the sender's notification bell so the closer knows the
 * client engaged.
 */
export async function confirmNurtureTouchFromPortal(
  clientUser: SessionUser,
  touchId: string,
): Promise<{ id: string; url: string | null; alreadyConfirmed: boolean }> {
  if (clientUser.role !== 'CLIENT' || !clientUser.portalClientId) {
    throw new NurtureError('This is only available inside the client portal.')
  }

  const touch = await db.nurtureTouch.findFirst({
    where: {
      id: touchId,
      organizationId: clientUser.organizationId,
      clientId: clientUser.portalClientId,
      kind: { in: PORTAL_VISIBLE_NURTURE_KINDS },
      client: clientScope(clientUser),
    },
    select: {
      id: true,
      kind: true,
      url: true,
      confirmedAt: true,
      senderId: true,
      clientId: true,
      client: { select: { firstName: true, lastName: true } },
    },
  })
  if (!touch || !portalCanConfirmTouch(clientUser, touch)) {
    throw new NurtureError('That item is not available.')
  }
  if (touch.confirmedAt) {
    return { id: touch.id, url: touch.url, alreadyConfirmed: true }
  }

  await db.nurtureTouch.update({
    where: { id: touch.id },
    data: { confirmedAt: new Date() },
  })

  const clientName = `${touch.client.firstName} ${touch.client.lastName}`

  await recordAudit(clientUser, {
    action: 'portal.nurture_confirmed',
    entityType: 'NurtureTouch',
    entityId: touch.id,
    summary: `${NURTURE_KIND_LABEL[touch.kind]} nurture opened by ${clientName} in the portal`,
  })

  await db.notification.create({
    data: {
      organizationId: clientUser.organizationId,
      userId: touch.senderId,
      kind: 'MESSAGE',
      title: `Nurture confirmed: ${clientName}`,
      body: `${clientName} opened your ${NURTURE_KIND_LABEL[touch.kind].toLowerCase()} in the portal.`,
      href: `/clients/${touch.clientId}`,
    },
  })

  return { id: touch.id, url: touch.url, alreadyConfirmed: false }
}
