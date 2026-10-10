/**
 * Turn stored Call Center rows into the desk list.
 * An empty list stays on the dummy seed. A real row never carries a full phone.
 */

import { seedLeads, type CallLead, type LeadChannel, type LeadLanguage, type LeadStatus, type TrailKind } from './model'
import { SCS_ENGLISH_PAGE_ID, readFacebookFormEvent } from './meta-route'

export type StoredCallCenterEvent = {
  type: string
  body: string
  createdAt: Date
}

export type StoredCallCenterLead = {
  id: string
  pageId: string | null
  source: 'FORM' | 'INBOUND'
  language: 'EN' | 'ES'
  status: 'WAITING' | 'INBOUND' | 'MISSED' | 'BOOKED'
  tries: number
  nextAttemptAt: Date | null
  lockedBy: string | null
  doNotCallAt: Date | null
  phoneLast4: string | null
  createdAt: Date
  events: StoredCallCenterEvent[]
  /** IANA zone staff set on the lead. Optional so older callers keep compiling. */
  timeZone?: string | null
}

function last4(value: string | null): string | null {
  if (!value || !/^\d{4}$/.test(value)) return null
  return value
}

function pageName(row: StoredCallCenterLead): string {
  if (row.pageId === SCS_ENGLISH_PAGE_ID || row.source === 'FORM') return 'Solar Contract Services'
  return 'Ad number'
}

function displayStatus(row: StoredCallCenterLead): LeadStatus {
  if (row.doNotCallAt) return 'dnc'
  if (row.status === 'BOOKED') return 'booked'
  if (row.tries > 0 && row.nextAttemptAt) return 'retry'
  if (row.status === 'INBOUND') return 'inbound'
  if (row.status === 'MISSED') return 'missed'
  return 'waiting'
}

function trailKind(type: string): TrailKind {
  switch (type) {
    case 'FORM': return 'form'
    case 'INBOUND': return 'inbound'
    case 'CALL': return 'call'
    case 'SMS': return 'sms'
    case 'OUTCOME': return 'outcome'
    case 'NOTE': return 'note'
    case 'LOCK': return 'lock'
    case 'INTAKE_LINK': return 'intake'
    default: return 'status'
  }
}

type EventCopy = {
  label?: string
  detail?: string
  action?: string
  userId?: string
  name?: string
  /** The VoiceCall a CALL / INBOUND event is about, when it came from the carrier. */
  voiceCallId?: string
}

function readCopy(body: string): EventCopy | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const copy: EventCopy = {}
    if (typeof parsed.label === 'string') copy.label = parsed.label
    if (typeof parsed.detail === 'string') copy.detail = parsed.detail
    if (typeof parsed.action === 'string') copy.action = parsed.action
    if (typeof parsed.userId === 'string') copy.userId = parsed.userId
    if (typeof parsed.name === 'string') copy.name = parsed.name
    if (typeof parsed.voiceCallId === 'string') copy.voiceCallId = parsed.voiceCallId
    return copy
  } catch {
    return null
  }
}

function safeText(value: string): string {
  return value.replace(/\d{5,}/g, '····').trim()
}

function trailLabel(type: string): string {
  switch (type) {
    case 'FORM': return 'Facebook form'
    case 'INBOUND': return 'Inbound call'
    case 'CALL': return 'Call'
    case 'SMS': return 'Text'
    case 'OUTCOME': return 'Result'
    case 'NOTE': return 'Note'
    case 'LOCK': return 'Lock'
    case 'INTAKE_LINK': return 'Intake link'
    case 'MESSENGER': return 'Messenger'
    default: return 'Update'
  }
}

function trailDetail(type: string, body: string, page: string, viewerId?: string | null): string {
  if (type === 'FORM') {
    return page === 'Solar Contract Services'
      ? 'Form received on Solar Contract Services'
      : 'Facebook form'
  }
  const copy = readCopy(body)
  if (type === 'LOCK' && copy?.action === 'take') {
    const name = safeText(copy.name || 'Another rep') || 'Another rep'
    return viewerId && copy.userId === viewerId ? 'You took this lead' : `${name} took this lead`
  }
  if (type === 'LOCK' && copy?.action === 'skip') return 'Skipped'
  if (copy?.detail) return safeText(copy.detail) || trailLabel(type)
  return safeText(body) || trailLabel(type)
}

function personName(row: StoredCallCenterLead): string {
  for (const event of row.events) {
    if (event.type !== 'FORM') continue
    const read = readFacebookFormEvent(event.body)
    if (read.name) return read.name
  }
  return 'Facebook lead'
}

function personZip(row: StoredCallCenterLead): string | null {
  for (const event of row.events) {
    if (event.type !== 'FORM') continue
    const read = readFacebookFormEvent(event.body)
    if (read.zip) return read.zip
  }
  return null
}

/** Real-call extras the desk loader attaches (never present on seed rows). */
export type CallLeadExtras = {
  /** VoiceCall id → its recording, for CALL / INBOUND events that name one. */
  recordings?: ReadonlyMap<string, { src: string; seconds: number }>
  /** The newest unhandled missed call from this lead. */
  missedCallId?: string | null
}

export function callLeadFromRow(
  row: StoredCallCenterLead,
  viewerId?: string | null,
  lockName?: string | null,
  extras: CallLeadExtras = {},
): CallLead {
  const page = pageName(row)
  const language: LeadLanguage = row.language === 'ES' ? 'es' : 'en'
  const channel: LeadChannel = row.source === 'INBOUND' ? 'inbound' : 'form'
  const contacted = row.tries > 0
    || row.doNotCallAt != null
    || row.status === 'BOOKED'
    || row.events.some((event) => event.type === 'CALL' || event.type === 'SMS' || event.type === 'OUTCOME')
  return {
    id: row.id,
    name: personName(row),
    language,
    channel,
    contacted,
    status: displayStatus(row),
    last4: last4(row.phoneLast4),
    zip: personZip(row),
    page,
    arrivedAt: row.createdAt.toISOString(),
    disabled: false,
    recording: null,
    trail: row.events.map((event) => {
      const copy = event.type === 'FORM' ? null : readCopy(event.body)
      const recording =
        copy?.voiceCallId && (event.type === 'CALL' || event.type === 'INBOUND')
          ? extras.recordings?.get(copy.voiceCallId)
          : undefined
      return {
        kind: trailKind(event.type),
        at: event.createdAt.toISOString(),
        label: copy?.label ? safeText(copy.label) || trailLabel(event.type) : trailLabel(event.type),
        detail: trailDetail(event.type, event.body, page, viewerId),
        ...(recording && event.type === 'CALL' ? { recording: { ...recording } } : {}),
      }
    }),
    lockedBy: row.lockedBy,
    lockName: lockName ?? null,
    persisted: true,
    tries: row.tries,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    dnc: row.doNotCallAt != null,
    timeZone: row.timeZone || 'America/Los_Angeles',
    ...(extras.missedCallId ? { missedCallId: extras.missedCallId } : {}),
  }
}

/** Real rows replace the seed. An empty table keeps the dummy desk. */
export function callLeadsForDesk(
  rows: readonly StoredCallCenterLead[],
  viewerId?: string | null,
  lockNames?: ReadonlyMap<string, string>,
  extras?: {
    recordings?: ReadonlyMap<string, { src: string; seconds: number }>
    missedByLead?: ReadonlyMap<string, string>
  },
): CallLead[] {
  if (rows.length === 0) return seedLeads()
  return rows.map((row) =>
    callLeadFromRow(row, viewerId, row.lockedBy ? lockNames?.get(row.lockedBy) ?? null : null, {
      recordings: extras?.recordings,
      missedCallId: extras?.missedByLead?.get(row.id) ?? null,
    }),
  )
}
