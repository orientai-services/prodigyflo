/**
 * Door 2 preview data. Facebook ad forms and calls to the number on those ads.
 * Nothing here is an SCS intake client, and nothing here dials a carrier.
 */

export const CALL_CENTER_COPY =
  'Ad form fills and inbound on the ad number. Not the SCS intake journey.'

export const PREVIEW_BANNER = 'Preview. Twilio is not connected.'

export type LeadLanguage = 'en' | 'es'
export type LeadChannel = 'form' | 'inbound'
export type LeadStatus = 'waiting' | 'inbound' | 'missed' | 'booked'
export type TrailKind = 'form' | 'inbound' | 'call' | 'sms' | 'status'
export type LeadTab = 'all' | 'forms' | 'inbound' | 'uncontacted' | 'missed' | 'booked'
export type LanguageFilter = 'all' | 'en' | 'es'
export type LeadAction = 'call' | 'text' | 'book' | 'missed'

export type TrailEvent = {
  kind: TrailKind
  at: string
  label: string
  detail: string
}

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
}

export const ZONE = 'America/Los_Angeles'

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

export function hasCall(lead: CallLead): boolean {
  return Boolean(lead.recording) || lead.trail.some((event) => event.kind === 'call' || event.kind === 'inbound')
}

export function visibleLeads(
  leads: CallLead[],
  tab: LeadTab,
  language: LanguageFilter,
  query: string,
): CallLead[] {
  const needle = query.trim().toLowerCase()
  return leads
    .filter((lead) => {
      if (language !== 'all' && lead.language !== language) return false
      if (needle && !`${lead.name} ${lead.page}`.toLowerCase().includes(needle)) return false
      if (tab === 'forms' && lead.channel !== 'form') return false
      if (tab === 'inbound' && lead.channel !== 'inbound') return false
      if (tab === 'uncontacted' && lead.contacted) return false
      if (tab === 'missed' && lead.status !== 'missed') return false
      if (tab === 'booked' && lead.status !== 'booked') return false
      return true
    })
    .slice()
    .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt))
}

export function applyLeadAction(lead: CallLead, action: LeadAction, at: string): CallLead {
  if (lead.disabled) return lead
  const next: CallLead = { ...lead, trail: lead.trail.map((event) => ({ ...event })) }
  if (action === 'call') {
    next.contacted = true
    next.recording = next.recording ?? { seconds: 12, label: 'Dummy recording' }
    next.trail.push({
      kind: 'call',
      at,
      label: 'Call',
      detail: 'Preview. Twilio is not connected.',
    })
  } else if (action === 'text') {
    next.contacted = true
    next.trail.push({
      kind: 'sms',
      at,
      label: 'Text',
      detail: 'Preview. Twilio is not connected.',
    })
  } else if (action === 'book') {
    next.contacted = true
    next.status = 'booked'
    next.trail.push({
      kind: 'status',
      at,
      label: 'Status → booked',
      detail: 'Callback booked on this preview row',
    })
  } else {
    next.status = 'missed'
    next.recording = next.recording ?? { seconds: 6, label: 'Dummy short recording' }
    next.trail.push({
      kind: 'status',
      at,
      label: 'Status → missed',
      detail: 'Marked missed on this preview row',
    })
  }
  next.trail.sort((a, b) => a.at.localeCompare(b.at))
  return next
}
