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

function trailDetail(type: string, body: string, page: string): string {
  if (type === 'FORM') {
    return page === 'Solar Contract Services'
      ? 'Form received on Solar Contract Services'
      : 'Facebook form'
  }
  const cleaned = body.replace(/\d{5,}/g, '····').trim()
  return cleaned || trailLabel(type)
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

export function callLeadFromRow(row: StoredCallCenterLead): CallLead {
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
    trail: row.events.map((event) => ({
      kind: trailKind(event.type),
      at: event.createdAt.toISOString(),
      label: trailLabel(event.type),
      detail: trailDetail(event.type, event.body, page),
    })),
    lockedBy: row.lockedBy,
    tries: row.tries,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    dnc: row.doNotCallAt != null,
    timeZone: 'America/Los_Angeles',
  }
}

/** Real rows replace the seed. An empty table keeps the dummy desk. */
export function callLeadsForDesk(rows: readonly StoredCallCenterLead[]): CallLead[] {
  if (rows.length === 0) return seedLeads()
  return rows.map((row) => callLeadFromRow(row))
}
