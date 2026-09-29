import { DEMO_PAGE_IDS, languageForPageId, pageName } from './pages'
import type { ApproachLanguage, CallCenterLead, CallCenterQueue, IngestPayload } from './types'

const leads: CallCenterLead[] = [
  {
    id: 'cc_demo_rosa',
    door: 'facebook_lead_ad',
    approachLanguage: 'es',
    sourcePageId: DEMO_PAGE_IDS.es,
    sourcePageName: pageName(DEMO_PAGE_IDS.es),
    adName: 'Form · quieres hablar',
    metaLeadgenId: 'demo_es_1',
    name: 'Rosa M.',
    phoneLast4: '4412',
    zip: '89108',
    queue: 'new',
    inbound: false,
    note: 'Spanish Facebook form. Did not start SCS intake.',
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    bookedAt: null,
    lastAction: null,
  },
  {
    id: 'cc_demo_james',
    door: 'facebook_lead_ad',
    approachLanguage: 'en',
    sourcePageId: DEMO_PAGE_IDS.en,
    sourcePageName: pageName(DEMO_PAGE_IDS.en),
    adName: 'Form · talk to a specialist',
    metaLeadgenId: 'demo_en_1',
    name: 'James H.',
    phoneLast4: '9088',
    zip: '89031',
    queue: 'new',
    inbound: false,
    note: 'English Facebook form. Call-first. No documents.',
    createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    bookedAt: null,
    lastAction: null,
  },
  {
    id: 'cc_demo_inbound',
    door: 'facebook_lead_ad',
    approachLanguage: 'en',
    sourcePageId: DEMO_PAGE_IDS.en,
    sourcePageName: pageName(DEMO_PAGE_IDS.en),
    adName: 'Called the English ad number',
    metaLeadgenId: null,
    name: 'Unknown inbound',
    phoneLast4: '1204',
    zip: '',
    queue: 'inbound',
    inbound: true,
    note: 'Dialed the number on the English ad. No form match yet.',
    createdAt: new Date().toISOString(),
    bookedAt: null,
    lastAction: null,
  },
  {
    id: 'cc_demo_elena',
    door: 'facebook_lead_ad',
    approachLanguage: 'es',
    sourcePageId: DEMO_PAGE_IDS.es,
    sourcePageName: pageName(DEMO_PAGE_IDS.es),
    adName: 'Form + inbound match',
    metaLeadgenId: 'demo_es_2',
    name: 'Elena V.',
    phoneLast4: '7731',
    zip: '89101',
    queue: 'new',
    inbound: true,
    note: 'Form first, then called the Spanish ad number. Same phone.',
    createdAt: new Date(Date.now() - 19 * 60_000).toISOString(),
    bookedAt: null,
    lastAction: null,
  },
  {
    id: 'cc_demo_chris',
    door: 'facebook_lead_ad',
    approachLanguage: 'en',
    sourcePageId: DEMO_PAGE_IDS.en,
    sourcePageName: pageName(DEMO_PAGE_IDS.en),
    adName: 'Form · talk to a specialist',
    metaLeadgenId: 'demo_en_2',
    name: 'Chris P.',
    phoneLast4: '5560',
    zip: '89014',
    queue: 'missed',
    inbound: false,
    note: 'No answer. Stays on Call Center missed. Not an intake case.',
    createdAt: new Date(Date.now() - 41 * 60_000).toISOString(),
    bookedAt: null,
    lastAction: 'missed',
  },
]

export function listLeads(filter?: { lang?: ApproachLanguage | 'all'; queue?: CallCenterQueue | 'all' }): CallCenterLead[] {
  return leads.filter((l) => {
    if (filter?.lang && filter.lang !== 'all' && l.approachLanguage !== filter.lang) return false
    if (filter?.queue && filter.queue !== 'all' && l.queue !== filter.queue) return false
    return true
  })
}

export function getLead(id: string): CallCenterLead | undefined {
  return leads.find((l) => l.id === id)
}

export function applyAction(id: string, action: 'call' | 'sms' | 'book' | 'missed'): CallCenterLead | undefined {
  const lead = getLead(id)
  if (!lead) return undefined
  lead.lastAction = action
  if (action === 'book') {
    lead.queue = 'booked'
    lead.bookedAt = new Date().toISOString()
  }
  if (action === 'missed') lead.queue = 'missed'
  if (action === 'call') lead.note = `${lead.note} · mock call (Twilio not plugged)`
  if (action === 'sms') lead.note = `${lead.note} · mock text (A2P not plugged)`
  return lead
}

function last4(phone: string | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '')
  return d.slice(-4) || '0000'
}

export function ingestForm(payload: IngestPayload): { ok: true; lead: CallCenterLead } | { ok: false; error: string } {
  const lang = languageForPageId(payload.page_id)
  if (!lang) return { ok: false, error: 'Unknown page_id. Set CALL_CENTER_PAGE_EN / CALL_CENTER_PAGE_ES.' }
  const existing = payload.leadgen_id ? leads.find((l) => l.metaLeadgenId === payload.leadgen_id) : undefined
  if (existing) return { ok: true, lead: existing }
  const lead: CallCenterLead = {
    id: `cc_${Date.now().toString(36)}`,
    door: 'facebook_lead_ad',
    approachLanguage: lang,
    sourcePageId: payload.page_id!,
    sourcePageName: pageName(payload.page_id!),
    adName: payload.ad_name || payload.campaign || 'Facebook lead form',
    metaLeadgenId: payload.leadgen_id ?? null,
    name: payload.name || 'Unknown',
    phoneLast4: last4(payload.phone),
    zip: payload.zip || '',
    queue: 'new',
    inbound: false,
    note: 'Ingested Door 2 form. Not an SCS journey client.',
    createdAt: new Date().toISOString(),
    bookedAt: null,
    lastAction: null,
  }
  leads.unshift(lead)
  return { ok: true, lead }
}
