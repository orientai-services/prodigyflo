import { ratio } from './metrics'

/**
 * Funnel by ad (docs/META_ADS_SCS.md §3.6). Pure. Leads come from each lead's
 * own stored ad id (MetaLeadTouch, matched only); spend and Meta's lead count
 * come from the synced window summary. Names come from synced rows only.
 */

export type FunnelRange = '7d' | '30d' | 'all'

export type FunnelRow = {
  adExternalId: string
  adName: string
  campaignName: string
  spend: number
  metaLeads: number
  leads: number
  contacted: number
  booked: number
  sat: number
  sold: number
  revenue: number
  costPerLead: number | null
  costPerBooked: number | null
  costPerSat: number | null
  costPerSale: number | null
  roas: number | null
  attributionDoubt: boolean
}

export type LeadOutcome = { contacted: boolean; booked: boolean; sat: boolean; sold: boolean; revenue: number }

/** sold ⇒ sat ⇒ booked ⇒ contacted. */
export function cascade(o: LeadOutcome): LeadOutcome {
  const sold = o.sold
  const sat = sold || o.sat
  const booked = sat || o.booked
  const contacted = booked || o.contacted
  return { contacted, booked, sat, sold, revenue: sold ? Math.max(0, o.revenue) : 0 }
}

/** |crm − meta| > max(1, 20% of the larger). */
export function attributionDoubt(crm: number, meta: number): boolean {
  return Math.abs(crm - meta) > Math.max(1, 0.2 * Math.max(crm, meta))
}

/**
 * One ad holds > 80% of CRM leads while Meta credits it with < 50% of its
 * leads, with at least 4 CRM leads and 4 Meta leads overall. Usually one lead
 * form shared by several ads.
 */
export function attributionBroken(rows: Pick<FunnelRow, 'leads' | 'metaLeads'>[]): boolean {
  const crm = rows.reduce((a, r) => a + r.leads, 0)
  const meta = rows.reduce((a, r) => a + r.metaLeads, 0)
  if (crm < 4 || meta < 4) return false
  return rows.some((r) => r.leads > 0.8 * crm && r.metaLeads < 0.5 * meta)
}

export type FunnelTouch = { adId: string; outcomeKey: string }

export function buildFunnelRows(input: {
  touches: FunnelTouch[]
  outcomes: Map<string, LeadOutcome>
  ads: Map<string, { name: string; campaignName: string }>
  spend: Map<string, { spend: number; metaLeads: number }>
}): FunnelRow[] {
  type Acc = { leads: number; contacted: number; booked: number; sat: number; sold: number; revenue: number }
  const acc = new Map<string, Acc>()
  for (const t of input.touches) {
    const a = acc.get(t.adId) ?? { leads: 0, contacted: 0, booked: 0, sat: 0, sold: 0, revenue: 0 }
    a.leads++
    const o = input.outcomes.get(t.outcomeKey)
    if (o) {
      const c = cascade(o)
      if (c.contacted) a.contacted++
      if (c.booked) a.booked++
      if (c.sat) a.sat++
      if (c.sold) a.sold++
      a.revenue += c.revenue
    }
    acc.set(t.adId, a)
  }

  const ids = new Set<string>([...acc.keys(), ...[...input.spend.entries()].filter(([, s]) => s.spend > 0 || s.metaLeads > 0).map(([k]) => k)])
  const rows: FunnelRow[] = []
  for (const id of ids) {
    const meta = input.ads.get(id)
    // Only ads that resolve to a synced, allowed row are shown by name; the
    // caller passes only matched touches, so an unknown id here is a sync gap.
    const a = acc.get(id) ?? { leads: 0, contacted: 0, booked: 0, sat: 0, sold: 0, revenue: 0 }
    const s = input.spend.get(id) ?? { spend: 0, metaLeads: 0 }
    const spend = Math.round(s.spend * 100) / 100
    rows.push({
      adExternalId: id,
      adName: meta?.name ?? 'Ad not synced yet',
      campaignName: meta?.campaignName ?? '',
      spend,
      metaLeads: s.metaLeads,
      ...a,
      revenue: Math.round(a.revenue * 100) / 100,
      costPerLead: ratio(spend, a.leads),
      costPerBooked: ratio(spend, a.booked),
      costPerSat: ratio(spend, a.sat),
      costPerSale: ratio(spend, a.sold),
      roas: ratio(a.revenue, spend),
      attributionDoubt: attributionDoubt(a.leads, s.metaLeads),
    })
  }
  return rows.sort((x, y) => y.spend - x.spend || y.leads - x.leads)
}
