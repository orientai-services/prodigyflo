/** Door 2 only. Facebook lead-ad forms + inbound on those ad numbers. */

export type ApproachLanguage = 'en' | 'es'
export type CallCenterQueue = 'new' | 'inbound' | 'missed' | 'booked'

export type CallCenterLead = {
  id: string
  door: 'facebook_lead_ad'
  approachLanguage: ApproachLanguage
  sourcePageId: string
  sourcePageName: string
  adName: string
  metaLeadgenId: string | null
  name: string
  phoneLast4: string
  zip: string
  queue: CallCenterQueue
  inbound: boolean
  note: string
  createdAt: string
  bookedAt: string | null
  lastAction: string | null
}

export type IngestPayload = {
  page_id?: string
  leadgen_id?: string
  name?: string
  phone?: string
  zip?: string
  campaign?: string
  ad_name?: string
}
