/**
 * Door 2 preview data. Facebook ad forms and calls to the number on those ads.
 * Nothing here is an SCS intake client, and nothing here dials a carrier.
 * Outcomes, the retry clock, the lock, and quiet hours are in-memory rules.
 */

export const CALL_CENTER_COPY =
  'Ad form fills and inbound on the ad number. Not the SCS intake journey.'

export const PREVIEW_BANNER = 'Preview. Twilio is not connected.'

export const QUIET_BANNER = 'Outside 8am–9pm local. Calls ask before you dial. Texts wait until morning.'

export const HELD_UNTIL_MORNING = 'held until morning'

export const INTAKE_QUEUED = 'SCS intake link queued · not a Client until they finish /begin'

export const CURRENT_REP = 'You'

export const TRY_LIMIT = 4

/** Days until the next try after attempt 1, 2, and 3. Attempt 4 stops. */
export const RETRY_DELAY_DAYS = [1, 3, 7] as const

const RECENT_FORM_MS = 7 * 24 * 60 * 60 * 1000

export type LeadLanguage = 'en' | 'es'
export type LeadChannel = 'form' | 'inbound'
export type LeadStatus = 'waiting' | 'inbound' | 'missed' | 'booked' | 'retry' | 'dnc'
export type TrailKind = 'form' | 'inbound' | 'call' | 'sms' | 'status' | 'outcome' | 'note' | 'lock' | 'intake'
export type LeadTab = 'all' | 'forms' | 'inbound' | 'uncontacted' | 'retry' | 'dnc'
export type LanguageFilter = 'all' | 'en' | 'es'
export type LeadAction = 'call' | 'text'
export type LeadOutcome =
  | 'talked'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'wrong_number'
  | 'not_interested'
  | 'callback'
  | 'appointment'
  | 'do_not_call'

export const OUTCOMES: { id: LeadOutcome; label: string }[] = [
  { id: 'talked', label: 'Talked' },
  { id: 'voicemail', label: 'Voicemail' },
  { id: 'no_answer', label: 'No answer' },
  { id: 'busy', label: 'Busy' },
  { id: 'wrong_number', label: 'Wrong number' },
  { id: 'not_interested', label: 'Not interested' },
  { id: 'callback', label: 'Callback' },
  { id: 'appointment', label: 'Appointment' },
  { id: 'do_not_call', label: 'Do not call' },
]

export type TrailEvent = {
  kind: TrailKind
  at: string
  label: string
  detail: string
  /** A real recording (voicemail or recorded call), played through /api/voice/recordings/<id>. */
  recording?: { src: string; seconds: number }
}

/** Seed data only. Real calls carry TrailEvent.recording instead. */
export type DummyRecording = {
  seconds: number
  label: string
}

export type CallLead = {
  id: string
  name: string
  subtitle?: string
  language: LeadLanguage
  channel: LeadChannel
  contacted: boolean
  status: LeadStatus
  /** Last four digits only. Never a full number. */
  last4: string | null
  zip: string | null
  page: string
  arrivedAt: string
  disabled: boolean
  recording: DummyRecording | null
  trail: TrailEvent[]
  lockedBy: string | null
  /** Display name when another rep holds the lock. */
  lockName?: string | null
  /** Saved on the server. Seed rows omit this and stay on this screen only. */
  persisted?: boolean
  tries: number
  nextAttemptAt: string | null
  dnc: boolean
  /** IANA zone for this lead's quiet hours. */
  timeZone: string
  /** The newest unhandled missed call from this lead (VoiceCall id), for "Call back" / ?missed=. */
  missedCallId?: string
}

export const ZONE = 'America/Los_Angeles'

const open = {
  lockedBy: null,
  tries: 0,
  nextAttemptAt: null,
  dnc: false,
  timeZone: 'America/Los_Angeles',
} as const

const SEED: CallLead[] = [
  {
    id: 'mara-ellison',
    name: 'Mara Ellison',
    language: 'en',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: '4419',
    zip: '89117',
    page: 'Solar Contract Services',
    arrivedAt: '2026-09-28T15:14:00.000Z',
    disabled: false,
    recording: null,
    trail: [
      {
        kind: 'form',
        at: '2026-09-28T15:14:00.000Z',
        label: 'Facebook form',
        detail: 'Form received on Solar Contract Services',
      },
    ],
    ...open,
  },
  {
    id: 'owen-briggs',
    name: 'Owen Briggs',
    language: 'en',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: '2208',
    zip: '85705',
    page: 'Solar Contract Services',
    arrivedAt: '2026-09-28T16:02:00.000Z',
    disabled: false,
    recording: null,
    trail: [
      {
        kind: 'form',
        at: '2026-09-28T16:02:00.000Z',
        label: 'Facebook form',
        detail: 'Form received on Solar Contract Services',
      },
    ],
    ...open,
    timeZone: 'America/Phoenix',
  },
  {
    id: 'jonah-hale',
    name: 'Jonah Hale',
    language: 'en',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: '9033',
    zip: '97202',
    page: 'Solar Contract Services',
    arrivedAt: '2026-09-28T16:20:00.000Z',
    disabled: false,
    recording: null,
    trail: [
      {
        kind: 'form',
        at: '2026-09-28T16:20:00.000Z',
        label: 'Facebook form',
        detail: 'Form received on Solar Contract Services',
      },
    ],
    ...open,
  },
  {
    id: 'chris-hale',
    name: 'Chris Hale',
    language: 'en',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: '5560',
    zip: '89117',
    page: 'Solar Contract Services',
    arrivedAt: '2026-09-28T14:10:00.000Z',
    disabled: false,
    recording: null,
    trail: [
      {
        kind: 'form',
        at: '2026-09-28T14:10:00.000Z',
        label: 'Facebook form',
        detail: 'Form received on Solar Contract Services',
      },
      {
        kind: 'lock',
        at: '2026-09-28T14:20:00.000Z',
        label: 'Lock',
        detail: 'Sam took this lead',
      },
    ],
    ...open,
    lockedBy: 'Sam',
  },
  {
    id: 'lila-chen',
    name: 'Lila Chen',
    language: 'en',
    channel: 'inbound',
    contacted: false,
    status: 'inbound',
    last4: '9033',
    zip: '97202',
    page: 'Ad number',
    arrivedAt: '2026-09-28T17:41:00.000Z',
    disabled: false,
    recording: { seconds: 18, label: 'Dummy inbound recording' },
    trail: [
      {
        kind: 'inbound',
        at: '2026-09-28T17:41:00.000Z',
        label: 'Inbound call',
        detail: 'Called the number on the English ad',
      },
    ],
    ...open,
  },
  {
    id: 'nate-fuller',
    name: 'Nate Fuller',
    language: 'en',
    channel: 'inbound',
    contacted: false,
    status: 'missed',
    last4: '1184',
    zip: '84101',
    page: 'Ad number',
    arrivedAt: '2026-09-27T22:11:00.000Z',
    disabled: false,
    recording: { seconds: 7, label: 'Dummy short recording' },
    trail: [
      {
        kind: 'inbound',
        at: '2026-09-27T22:11:00.000Z',
        label: 'Inbound call',
        detail: 'Called the number on the English ad',
      },
      {
        kind: 'call',
        at: '2026-09-27T22:11:20.000Z',
        label: 'Call',
        detail: 'Missed. Short dummy recording only.',
      },
      {
        kind: 'status',
        at: '2026-09-27T22:12:00.000Z',
        label: 'Status → missed',
        detail: 'Marked missed',
      },
    ],
    ...open,
    timeZone: 'America/Denver',
  },
  {
    id: 'helen-cho',
    name: 'Helen Cho',
    language: 'en',
    channel: 'inbound',
    contacted: true,
    status: 'booked',
    last4: '6670',
    zip: '98104',
    page: 'Ad number',
    arrivedAt: '2026-09-27T19:05:00.000Z',
    disabled: false,
    recording: { seconds: 42, label: 'Dummy connected recording' },
    trail: [
      {
        kind: 'inbound',
        at: '2026-09-27T19:05:00.000Z',
        label: 'Inbound call',
        detail: 'Called the number on the English ad',
      },
      {
        kind: 'call',
        at: '2026-09-27T19:06:00.000Z',
        label: 'Call',
        detail: 'Connected. Dummy recording only.',
      },
      {
        kind: 'sms',
        at: '2026-09-27T19:12:00.000Z',
        label: 'Text',
        detail: 'Dummy text: callback time confirmed.',
      },
      {
        kind: 'status',
        at: '2026-09-27T19:13:00.000Z',
        label: 'Status → booked',
        detail: 'Callback booked',
      },
    ],
    ...open,
  },
  {
    id: 'riley-cho',
    name: 'Riley Cho',
    language: 'en',
    channel: 'form',
    contacted: true,
    last4: '0091',
    zip: '89119',
    page: 'Solar Contract Services',
    arrivedAt: '2026-09-27T18:00:00.000Z',
    disabled: false,
    recording: null,
    trail: [
      {
        kind: 'sms',
        at: '2026-09-27T18:04:00.000Z',
        label: 'Text',
        detail: 'STOP on a text',
      },
      {
        kind: 'outcome',
        at: '2026-09-27T18:04:01.000Z',
        label: 'Do not call',
        detail: 'Added to Do not call',
      },
    ],
    ...open,
    dnc: true,
    status: 'dnc',
  },
  {
    id: 'es-page',
    name: 'Spanish placeholder',
    subtitle: 'page not connected',
    language: 'es',
    channel: 'form',
    contacted: false,
    status: 'waiting',
    last4: null,
    zip: null,
    page: 'page not connected',
    arrivedAt: '2026-09-28T18:00:00.000Z',
    disabled: true,
    recording: null,
    trail: [
      {
        kind: 'form',
        at: '2026-09-28T18:00:00.000Z',
        label: 'Facebook form',
        detail: 'Spanish Facebook Page is not connected',
      },
    ],
    ...open,
  },
]

export function seedLeads(): CallLead[] {
  return structuredClone(SEED)
}

export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function channelLabel(channel: LeadChannel): string {
  return channel === 'form' ? 'Facebook form' : 'Inbound call'
}

export function badgeLabel(channel: LeadChannel): string {
  return channel === 'form' ? 'FORM' : 'INBOUND'
}

export function languageLabel(language: LeadLanguage): string {
  return language === 'en' ? 'EN' : 'ES'
}

export function languageName(language: LeadLanguage): string {
  return language === 'en' ? 'English' : 'Spanish'
}

export function phoneLabel(lead: CallLead): string {
  return lead.last4 ? `···· ${lead.last4}` : '—'
}

export function triesLine(lead: CallLead): string {
  return `Tries ${lead.tries} of ${TRY_LIMIT}`
}

export function nextTryLine(lead: CallLead): string | null {
  if (lead.nextAttemptAt) return `Next try ${formatWhen(lead.nextAttemptAt)}`
  if (lead.tries >= TRY_LIMIT) return 'No further tries'
  return null
}

export function autoTextDetail(language: LeadLanguage): string {
  return `Auto-text queued in ${languageName(language)} · not sent`
}

export function hasCall(lead: CallLead): boolean {
  return Boolean(lead.recording) || lead.trail.some((event) => event.kind === 'call' || event.kind === 'inbound')
}

export function localHour(iso: string, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(iso))
    .find((part) => part.type === 'hour')?.value
  const value = Number(hour)
  return value === 24 ? 0 : value
}

/** Call window is 8:00 inclusive through 9:00 exclusive, in the lead's zone. */
export function callNeedsConfirm(lead: CallLead, at: string): boolean {
  const hour = localHour(at, lead.timeZone)
  return hour < 8 || hour >= 21
}

/** Text window is 9:00 inclusive through 8:00pm exclusive, in the lead's zone. */
export function textHeldUntilMorning(lead: CallLead, at: string): boolean {
  const hour = localHour(at, lead.timeZone)
  return hour < 9 || hour >= 20
}

export function lockedToOther(lead: CallLead, rep = CURRENT_REP): boolean {
  return Boolean(lead.lockedBy && lead.lockedBy !== rep)
}

export function lockLabel(lead: CallLead, rep = CURRENT_REP): string | null {
  if (!lead.lockedBy) return null
  return lead.lockedBy === rep ? 'Locked to you' : `Locked · ${lead.lockName || lead.lockedBy}`
}

export function canCall(lead: CallLead, rep = CURRENT_REP): boolean {
  return !lead.disabled && !lead.dnc && !lockedToOther(lead, rep)
}

export function canText(lead: CallLead, rep = CURRENT_REP): boolean {
  return canCall(lead, rep)
}

export function canTake(lead: CallLead, rep = CURRENT_REP): boolean {
  return !lead.disabled && !lead.dnc && !lead.lockedBy && !lockedToOther(lead, rep)
}

export function canSendIntake(lead: CallLead, rep = CURRENT_REP): boolean {
  return canCall(lead, rep)
}

export function canRecordOutcome(lead: CallLead, rep = CURRENT_REP): boolean {
  return canCall(lead, rep)
}

export function canSaveNote(lead: CallLead, rep = CURRENT_REP): boolean {
  return !lead.disabled && !lockedToOther(lead, rep)
}

export function retryDelayDays(tries: number): number | null {
  if (tries < 1 || tries > RETRY_DELAY_DAYS.length) return null
  return RETRY_DELAY_DAYS[tries - 1]
}

export function nextRetryAt(tries: number, at: string): string | null {
  const days = retryDelayDays(tries)
  if (days == null) return null
  return new Date(Date.parse(at) + days * 24 * 60 * 60 * 1000).toISOString()
}

export function visibleLeads(
  leads: CallLead[],
  tab: LeadTab,
  language: LanguageFilter,
  query: string,
): CallLead[] {
  const needle = query.trim().toLowerCase()
  const rows = leads.filter((lead) => {
    if (language !== 'all' && lead.language !== language) return false
    if (needle && !`${lead.name} ${lead.page}`.toLowerCase().includes(needle)) return false
    if (tab === 'forms' && lead.channel !== 'form') return false
    if (tab === 'inbound' && lead.channel !== 'inbound') return false
    if (tab === 'uncontacted' && lead.contacted) return false
    if (tab === 'retry' && lead.status !== 'retry') return false
    if (tab === 'dnc' && !lead.dnc) return false
    return true
  })
  const newestFirst = tab !== 'uncontacted'
  return rows.slice().sort((a, b) => (newestFirst ? b.arrivedAt.localeCompare(a.arrivedAt) : a.arrivedAt.localeCompare(b.arrivedAt)))
}

export function nextCallableLead(leads: CallLead[], fromId: string, rep = CURRENT_REP): CallLead | null {
  const callable = leads.filter((lead) => canCall(lead, rep))
  if (!callable.length) return null
  const index = callable.findIndex((lead) => lead.id === fromId)
  if (index === -1) return callable[0]
  return callable[(index + 1) % callable.length]
}

export function inboundFormMatch(lead: CallLead, leads: CallLead[]): string | null {
  if (lead.channel !== 'inbound') return null
  if (!lead.last4) return 'No form match'
  const arrived = Date.parse(lead.arrivedAt)
  const match = leads
    .filter((other) => {
      if (other.channel !== 'form' || other.disabled || other.last4 !== lead.last4) return false
      const formAt = Date.parse(other.arrivedAt)
      return formAt <= arrived && arrived - formAt <= RECENT_FORM_MS
    })
    .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt))[0]
  return match ? `Possible match: ${match.name}` : 'No form match'
}

function cloneLead(lead: CallLead): CallLead {
  return {
    ...lead,
    recording: lead.recording ? { ...lead.recording } : null,
    trail: lead.trail.map((event) => ({ ...event })),
  }
}

function pushTrail(lead: CallLead, event: TrailEvent) {
  lead.trail.push(event)
  lead.trail.sort((a, b) => a.at.localeCompare(b.at))
}

export function applyLeadAction(lead: CallLead, action: LeadAction, at: string, rep = CURRENT_REP): CallLead {
  if (!canCall(lead, rep) && action === 'call') return lead
  if (!canText(lead, rep) && action === 'text') return lead
  const next = cloneLead(lead)
  if (action === 'call') {
    next.recording = next.recording ?? { seconds: 12, label: 'Dummy recording' }
    pushTrail(next, {
      kind: 'call',
      at,
      label: 'Call',
      detail: PREVIEW_BANNER,
    })
    return next
  }
  pushTrail(next, {
    kind: 'sms',
    at,
    label: 'Text',
    detail: textHeldUntilMorning(next, at) ? HELD_UNTIL_MORNING : PREVIEW_BANNER,
  })
  return next
}

export function applyOutcome(lead: CallLead, outcome: LeadOutcome, at: string, rep = CURRENT_REP): CallLead {
  if (!canRecordOutcome(lead, rep)) return lead
  const label = OUTCOMES.find((item) => item.id === outcome)?.label ?? outcome
  const next = cloneLead(lead)
  next.contacted = true
  if (outcome === 'talked' || outcome === 'appointment') {
    next.status = 'booked'
    next.nextAttemptAt = null
    pushTrail(next, { kind: 'outcome', at, label, detail: 'Moved to booked' })
    return next
  }
  if (outcome === 'do_not_call') {
    next.status = 'dnc'
    next.dnc = true
    next.nextAttemptAt = null
    pushTrail(next, { kind: 'outcome', at, label, detail: 'Added to Do not call' })
    return next
  }
  if (outcome === 'no_answer' || outcome === 'busy' || outcome === 'voicemail') {
    if (lead.tries >= TRY_LIMIT) return lead
    const tries = next.tries + 1
    next.tries = tries
    next.status = 'retry'
    next.nextAttemptAt = nextRetryAt(tries, at)
    pushTrail(next, {
      kind: 'outcome',
      at,
      label,
      detail: next.nextAttemptAt ? `Next try ${next.nextAttemptAt}` : 'No further tries',
    })
    if (outcome === 'no_answer') {
      pushTrail(next, {
        kind: 'sms',
        at,
        label: 'Text',
        detail: autoTextDetail(next.language),
      })
    }
    return next
  }
  if (next.status === 'retry') next.status = 'waiting'
  next.nextAttemptAt = null
  pushTrail(next, { kind: 'outcome', at, label, detail: 'Result recorded' })
  return next
}

export function takeLead(lead: CallLead, rep = CURRENT_REP, at = new Date().toISOString()): CallLead {
  if (!canTake(lead, rep)) return lead
  const next = cloneLead(lead)
  next.lockedBy = rep
  pushTrail(next, { kind: 'lock', at, label: 'Lock', detail: 'You took this lead' })
  return next
}

export function saveNote(lead: CallLead, text: string, at: string, rep = CURRENT_REP): CallLead {
  const detail = text.trim()
  if (!detail || !canSaveNote(lead, rep)) return lead
  const next = cloneLead(lead)
  pushTrail(next, { kind: 'note', at, label: 'Note', detail })
  return next
}

export function sendIntakeLink(lead: CallLead, at: string, rep = CURRENT_REP): CallLead {
  if (!canSendIntake(lead, rep)) return lead
  const next = cloneLead(lead)
  pushTrail(next, { kind: 'intake', at, label: 'Intake link', detail: INTAKE_QUEUED })
  return next
}
