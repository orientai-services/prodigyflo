import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { AppointmentType, DocumentStatus, StageKey } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, getSessionUser, type SessionUser } from '@/lib/rbac'

/**
 * Data layer for the client portal — the only surface a CLIENT-role user can
 * reach. Everything here is scoped to the caller's own Client row and speaks
 * client-safe language: internal pipeline vocabulary never crosses this file.
 *
 * All user-facing copy lives in PORTAL_COPY / the view maps below so a future
 * translation is a one-file job.
 */

// ─── Copy ────────────────────────────────────────────────────────────────────

export const PORTAL_COPY = {
  brandTagline: 'Your client portal',
  signOut: 'Sign out',
  advisorLabel: 'Your advisor',
  progressTitle: 'Where things stand',
  progressNeutralTitle: 'Let’s talk',
  progressNeutralBody:
    'Your file needs a quick conversation before it moves forward. Send us a message below or reach out to your advisor — we’re happy to walk you through it.',
  documentsTitle: 'Your documents',
  documentsSubtitle: 'Everything we need from you, in one place. A clear phone photo works great.',
  documentsEmptyTitle: 'Nothing needed right now',
  documentsEmptyBody: 'When we need a document from you, it will appear here with a simple upload button.',
  uploadCta: 'Upload',
  uploadReplaceCta: 'Upload a new copy',
  uploadBusy: 'Uploading…',
  uploadSuccess: 'Got it — thank you! Our team will review it shortly.',
  uploadFailed: 'That upload didn’t go through. Please try again.',
  messagesTitle: 'Messages',
  messagesSubtitle: 'Your conversation with our team.',
  messagesEmptyTitle: 'No messages yet',
  messagesEmptyBody: 'Have a question? Write to us below — your team sees it right away.',
  messagePlaceholder: 'Write a message to your team…',
  messageSend: 'Send message',
  messageSending: 'Sending…',
  messageSent: 'Message sent. Your team has been notified.',
  messageEmpty: 'Please write a message first.',
  messageYou: 'You',
  appointmentsTitle: 'Upcoming appointments',
  appointmentsEmptyTitle: 'Nothing scheduled',
  appointmentsEmptyBody: 'When an appointment is booked for you, the details will show up here.',
  needHelp: 'Questions? Send us a message any time — we usually reply within one business day.',
} as const

// ─── Progress tracker ────────────────────────────────────────────────────────

/** The friendly milestones a client sees — never the internal 25-stage pipeline. */
export const PORTAL_STEPS = [
  { key: 'started', label: 'Getting started' },
  { key: 'review', label: 'Reviewing your options' },
  { key: 'consultation', label: 'Your consultation' },
  { key: 'documents', label: 'Gathering documents' },
  { key: 'final', label: 'Final review' },
  { key: 'done', label: 'All wrapped up' },
] as const

export type StageView = {
  /** Index into PORTAL_STEPS, or null for the neutral "speak with your advisor" state. */
  step: number | null
  headline: string
  detail: string
}

/**
 * Client-safe view of every internal stage. Terminal-negative and on-hold
 * states map to the neutral view — a client never reads "lost" or
 * "disqualified", and credit terminology never appears.
 */
export const CLIENT_STAGE_VIEWS: Record<StageKey, StageView> = {
  NEW_LEAD: { step: 0, headline: 'Welcome aboard', detail: 'We’ve received your information and our team is getting your file set up.' },
  SURVEY_STARTED: { step: 0, headline: 'Finishing your survey', detail: 'Your survey is almost done — completing it helps us move faster for you.' },
  SURVEY_COMPLETED: { step: 0, headline: 'Survey received', detail: 'Thanks for completing your survey. Our team is looking everything over.' },
  INFO_VERIFICATION: { step: 0, headline: 'Confirming your details', detail: 'We’re double-checking your contact details so nothing slips through the cracks.' },
  CONSENT_PENDING: { step: 1, headline: 'A quick authorization', detail: 'We’re waiting on a short authorization from you. Check your email, or message us if you can’t find it.' },
  CREDIT_PULL_PENDING: { step: 1, headline: 'Reviewing your options', detail: 'We’re gathering what we need to review your options. Nothing is needed from you right now.' },
  CREDIT_PULL_COMPLETED: { step: 1, headline: 'Reviewing your options', detail: 'Our team is reviewing your options and will be in touch with next steps.' },
  QUALIFICATION_REVIEW: { step: 1, headline: 'Almost through review', detail: 'A specialist is taking a careful look at your file right now.' },
  QUALIFIED: { step: 1, headline: 'Good news — moving forward', detail: 'Your review is complete and your file is moving to the next step.' },
  APPOINTMENT_SCHEDULING: { step: 2, headline: 'Let’s find a time', detail: 'We’re lining up a time to talk. Keep an eye out for scheduling options.' },
  APPOINTMENT_SCHEDULED: { step: 2, headline: 'You’re on the calendar', detail: 'Your appointment is booked — the details are below.' },
  PRESENTATION_COMPLETED: { step: 2, headline: 'Thanks for meeting with us', detail: 'We’ve walked through everything together. Take your time — we’re here for questions.' },
  FOLLOW_UP: { step: 2, headline: 'Whenever you’re ready', detail: 'We’re standing by while you think things over. Message us with any questions.' },
  PAYMENT_SELECTION: { step: 2, headline: 'Choosing what works for you', detail: 'We’re helping you settle on the arrangement that fits you best.' },
  DOCUMENT_COLLECTION: { step: 3, headline: 'A few documents to go', detail: 'We need a few documents from you — the list below shows exactly what’s left.' },
  COMMUNICATION_EVIDENCE_REVIEW: { step: 3, headline: 'Reviewing what you sent', detail: 'Thanks for sending your documents — our team is reviewing them now.' },
  ATTORNEY_DOCUMENT_REVIEW: { step: 3, headline: 'Professional review underway', detail: 'Your documents are getting a careful professional review. No action needed from you.' },
  DEAL_READY_FOR_SUBMISSION: { step: 4, headline: 'Preparing your submission', detail: 'Everything is in — we’re packaging your file for submission.' },
  SUBMITTED: { step: 4, headline: 'Submitted', detail: 'Your file has been submitted. We’ll let you know the moment we hear back.' },
  CORRECTIONS_REQUESTED: { step: 4, headline: 'A small fix needed', detail: 'The reviewers asked for a small correction. We’re on it, and we’ll reach out if we need anything from you.' },
  APPROVED: { step: 4, headline: 'Approved', detail: 'Great news — your file has been approved. Final steps are underway.' },
  CLOSED_WON: { step: 5, headline: 'All wrapped up', detail: 'Everything is complete. Thank you for trusting us — we’re still here if you need anything.' },
  CLOSED_LOST: { step: null, headline: 'Speak with your advisor', detail: 'Your file needs a quick conversation before it moves forward. Send us a message below or reach out to your advisor — we’re happy to walk you through it.' },
  NOT_QUALIFIED: { step: null, headline: 'Speak with your advisor', detail: 'Your file needs a quick conversation before it moves forward. Send us a message below or reach out to your advisor — we’re happy to walk you through it.' },
  ON_HOLD: { step: null, headline: 'Your file is paused', detail: 'Your file is on a short pause. Message us below and we’ll pick things right back up.' },
}

export function clientStageView(key: StageKey): StageView {
  return (
    CLIENT_STAGE_VIEWS[key] ?? {
      step: null,
      headline: 'Speak with your advisor',
      detail: PORTAL_COPY.progressNeutralBody,
    }
  )
}

// ─── Documents ───────────────────────────────────────────────────────────────

export type DocTone = 'needed' | 'received' | 'reviewing' | 'approved' | 'action'

/** Client-safe reading of every internal document status. */
export const DOC_STATUS_VIEWS: Record<DocumentStatus, { label: string; tone: DocTone; hint: string }> = {
  REQUESTED: { label: 'Needed', tone: 'needed', hint: 'Please upload this when you can.' },
  RECEIVED: { label: 'Received', tone: 'received', hint: 'We have it — review starts soon.' },
  PROCESSING: { label: 'Received', tone: 'received', hint: 'We have it — review starts soon.' },
  UNDER_REVIEW: { label: 'Being reviewed', tone: 'reviewing', hint: 'Our team is looking at it now.' },
  MISSING_INFORMATION: { label: 'Needs a new copy', tone: 'action', hint: 'Part of it was hard to read — please upload a clearer copy.' },
  APPROVED: { label: 'Approved', tone: 'approved', hint: 'All set — nothing more needed here.' },
  REJECTED: { label: 'Needs a new copy', tone: 'action', hint: 'Please upload a new copy.' },
  EXPIRED: { label: 'Needs a new copy', tone: 'action', hint: 'This one is out of date — please upload a current copy.' },
}

/** Statuses a client may upload against. Approved and in-review files are locked. */
const UPLOADABLE_STATUSES: DocumentStatus[] = ['REQUESTED', 'RECEIVED', 'MISSING_INFORMATION', 'REJECTED', 'EXPIRED']

export function canClientUpload(status: DocumentStatus): boolean {
  return UPLOADABLE_STATUSES.includes(status)
}

// ─── Appointments ────────────────────────────────────────────────────────────

export const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  DISCOVERY: 'Introductory call',
  PRESENTATION: 'Consultation',
  FOLLOW_UP: 'Follow-up conversation',
  DOCUMENT_REVIEW: 'Document review',
  CLOSING: 'Final review meeting',
}

// ─── Access ──────────────────────────────────────────────────────────────────

/**
 * The portal client for a session, or null when this session has no portal.
 * Goes through clientScope so a CLIENT session can only ever resolve the one
 * Client row whose portalUserId is their own — never anyone else's.
 */
export async function findPortalClient(user: SessionUser) {
  if (user.role !== 'CLIENT' || !user.portalClientId) return null
  return db.client.findFirst({
    where: { AND: [clientScope(user), { id: user.portalClientId }] },
    include: {
      currentStage: { select: { key: true } },
      owner: { select: { id: true, name: true } },
      organization: { select: { name: true } },
    },
  })
}

/**
 * Guard for every portal page: signed in, CLIENT role, linked client row —
 * anything else lands on /login. Cached, so layout + page share one lookup.
 */
export const requirePortalClient = cache(async () => {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  const client = await findPortalClient(user)
  if (!client) redirect('/login')
  return { user, client }
})

// ─── Loaders (all take an already-verified portal clientId) ──────────────────

export type PortalDocument = {
  requirementId: string
  name: string
  description: string | null
  status: DocumentStatus
  version: number
  receivedAt: Date | null
  /** The one comment field written for client eyes. Internal comments never leave the server. */
  clientVisibleComment: string | null
  canUpload: boolean
}

/**
 * The client's checklist: the latest version of every requirement staff has
 * requested from them. Ad-hoc staff uploads (no requirement) stay internal.
 */
export async function loadPortalDocuments(clientId: string): Promise<PortalDocument[]> {
  const docs = await db.clientDocument.findMany({
    where: { clientId, requirementId: { not: null } },
    orderBy: { version: 'desc' },
    select: {
      requirementId: true,
      status: true,
      version: true,
      receivedAt: true,
      clientVisibleComment: true,
      requirement: { select: { name: true, description: true, position: true } },
    },
  })

  const latest = new Map<string, (typeof docs)[number]>()
  for (const d of docs) {
    if (d.requirementId && !latest.has(d.requirementId)) latest.set(d.requirementId, d)
  }

  return [...latest.values()]
    .sort((a, b) => (a.requirement?.position ?? 0) - (b.requirement?.position ?? 0))
    .map((d) => ({
      requirementId: d.requirementId as string,
      name: d.requirement?.name ?? 'Document',
      description: d.requirement?.description ?? null,
      status: d.status,
      version: d.version,
      receivedAt: d.receivedAt,
      clientVisibleComment: d.clientVisibleComment,
      canUpload: canClientUpload(d.status),
    }))
}

export type PortalMessage = {
  id: string
  direction: 'INBOUND' | 'OUTBOUND'
  subject: string | null
  body: string | null
  occurredAt: Date
  senderName: string
}

/**
 * Written messages between the client and the team, oldest first. Internal
 * comms, notes, and call logs are excluded before anything leaves the server.
 */
export async function loadPortalMessages(clientId: string, teamFallback: string): Promise<PortalMessage[]> {
  const comms = await db.communication.findMany({
    where: {
      clientId,
      isInternal: false,
      channel: { in: ['EMAIL', 'SMS', 'IMESSAGE', 'PORTAL_MESSAGE', 'MESSENGER'] },
    },
    orderBy: { occurredAt: 'desc' },
    take: 50,
    select: {
      id: true,
      direction: true,
      subject: true,
      body: true,
      occurredAt: true,
      user: { select: { name: true } },
    },
  })

  return comms.reverse().map((c) => ({
    id: c.id,
    direction: c.direction,
    subject: c.subject,
    body: c.body,
    occurredAt: c.occurredAt,
    senderName: c.direction === 'INBOUND' ? PORTAL_COPY.messageYou : (c.user?.name ?? teamFallback),
  }))
}

export type PortalAppointment = {
  id: string
  typeLabel: string
  startsAt: Date
  endsAt: Date
  timezone: string
  location: string | null
  meetingUrl: string | null
  withName: string
  isConfirmed: boolean
}

export async function loadPortalAppointments(clientId: string): Promise<PortalAppointment[]> {
  const appts = await db.appointment.findMany({
    where: {
      clientId,
      status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] },
      startsAt: { gte: new Date() },
    },
    orderBy: { startsAt: 'asc' },
    take: 10,
    select: {
      id: true,
      type: true,
      status: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      location: true,
      meetingUrl: true,
      owner: { select: { name: true } },
    },
  })

  return appts.map((a) => ({
    id: a.id,
    typeLabel: APPOINTMENT_TYPE_LABELS[a.type],
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    timezone: a.timezone,
    location: a.location,
    meetingUrl: a.meetingUrl,
    withName: a.owner.name,
    isConfirmed: a.status === 'CONFIRMED',
  }))
}

// ─── Upload authorization ────────────────────────────────────────────────────

export type PortalUploadTarget =
  | {
      ok: true
      client: { id: string; firstName: string; lastName: string }
      requirement: { id: string; name: string; allowedMimeTypes: string[]; maxSizeMb: number }
    }
  | { ok: false; status: number; error: string }

/**
 * May this session upload against this requirement? Three gates, in order:
 * the session resolves to its own portal client (scope), the requirement has
 * actually been requested from THAT client (ownership — a requirement id from
 * someone else's checklist dies here), and the latest version is in a state a
 * client may replace (approved / in-review files are locked).
 */
export async function portalUploadTarget(user: SessionUser, requirementId: string): Promise<PortalUploadTarget> {
  if (user.role !== 'CLIENT' || !user.portalClientId) {
    return { ok: false, status: 403, error: 'This upload is only available inside the client portal.' }
  }

  const client = await db.client.findFirst({
    where: { AND: [clientScope(user), { id: user.portalClientId }] },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!client) return { ok: false, status: 403, error: 'Your portal is not available right now.' }

  const requirement = await db.documentRequirement.findFirst({
    where: {
      id: requirementId,
      package: { organizationId: user.organizationId },
      documents: { some: { clientId: client.id } },
    },
    select: { id: true, name: true, allowedMimeTypes: true, maxSizeMb: true },
  })
  if (!requirement) return { ok: false, status: 404, error: 'We are not expecting that document from you.' }

  const latestDoc = await db.clientDocument.findFirst({
    where: { clientId: client.id, requirementId: requirement.id },
    orderBy: { version: 'desc' },
    select: { status: true },
  })
  if (latestDoc && !canClientUpload(latestDoc.status)) {
    return { ok: false, status: 409, error: 'This document is already being reviewed — no new copy is needed.' }
  }

  return { ok: true, client, requirement }
}
