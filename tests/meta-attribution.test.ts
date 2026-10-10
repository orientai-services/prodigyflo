import { describe, expect, it } from 'vitest'
import {
  GRAPH_LEAD_FIELDS, attributionFromGraph, attributionRows, isNevadaZip, leadArea, leadFromGraphResponse,
  normalizePlatform, normalizeState, storedAttribution, withWebhookIds,
} from '@/lib/meta/attribution'
import { fixtureLeadFrom, metaFixtureModeEnabled } from '@/lib/meta/fixture'

const graphLead = {
  id: 'lg_1',
  created_time: '2026-10-07T16:00:00+0000',
  field_data: [
    { name: 'full_name', values: ['Ana Test'] },
    { name: 'email', values: ['ana@example.test'] },
  ],
  ad_id: '111', ad_name: 'Video A', adset_id: '222', adset_name: 'LV 35+',
  campaign_id: '333', campaign_name: 'Q4 Review', form_id: '444', platform: 'ig', is_organic: false,
}

describe('Meta lead attribution', () => {
  it('asks Graph for the attribution ids on the lead read, never the names', () => {
    for (const f of ['ad_id', 'adset_id', 'campaign_id', 'form_id', 'platform', 'is_organic', 'field_data']) {
      expect(GRAPH_LEAD_FIELDS.split(',')).toContain(f)
    }
    // A lead on a shared Page can come from another ad account: its names are never fetched.
    for (const f of ['ad_name', 'adset_name', 'campaign_name']) expect(GRAPH_LEAD_FIELDS.split(',')).not.toContain(f)
  })

  it('maps a Graph lead into fields + attribution', () => {
    const lead = leadFromGraphResponse(graphLead)
    expect(lead.leadgenId).toBe('lg_1')
    expect(lead.fields).toEqual({ full_name: 'Ana Test', email: 'ana@example.test' })
    // Names are dropped even when a response carries them.
    expect(lead.attribution).toEqual({
      adId: '111', adName: null, adsetId: '222', adsetName: null,
      campaignId: '333', campaignName: null, formId: '444', platform: 'ig', isOrganic: false,
    })
  })

  it('rejects a Graph response with no id', () => {
    expect(() => leadFromGraphResponse({} as never)).toThrow(/no id/)
  })

  it('fills gaps from the webhook ids, Graph wins when both exist', () => {
    const a = attributionFromGraph({ ad_id: 'g_ad' }, { adId: 'w_ad', adsetId: 'w_as', formId: 'w_form' })
    expect(a.adId).toBe('g_ad')
    expect(a.adsetId).toBe('w_as')
    expect(a.formId).toBe('w_form')
    expect(a.campaignId).toBeNull()
    const b = withWebhookIds(undefined, { adId: 'x', adsetId: 'y', formId: 'z' })
    expect([b.adId, b.adsetId, b.formId]).toEqual(['x', 'y', 'z'])
  })

  it('normalizes platform and is_organic', () => {
    expect(normalizePlatform('FB')).toBe('fb')
    expect(normalizePlatform('instagram')).toBe('ig')
    expect(normalizePlatform('')).toBeNull()
    expect(normalizePlatform('msgr')).toBe('msgr')
    expect(attributionFromGraph({ is_organic: 'true' }).isOrganic).toBe(true)
    expect(attributionFromGraph({}).isOrganic).toBeNull()
  })
})

describe('out-of-area flag (state != NV)', () => {
  it('normalizes state names and codes', () => {
    expect(normalizeState('Nevada')).toBe('NV')
    expect(normalizeState(' nv. ')).toBe('NV')
    expect(normalizeState('California')).toBe('CA')
    expect(normalizeState('Narnia')).toBeNull()
  })

  it('NV leads are in area', () => {
    expect(leadArea({ state: 'NV' })).toEqual({ state: 'NV', source: 'state', outOfArea: false })
    expect(leadArea({ state: 'nevada', zip_code: '90210' }).outOfArea).toBe(false) // stated state wins
  })

  it('other states are flagged out of area', () => {
    expect(leadArea({ state: 'AZ' })).toEqual({ state: 'AZ', source: 'state', outOfArea: true })
    expect(leadArea({ province: 'Utah' }).outOfArea).toBe(true)
  })

  it('falls back to the ZIP when no state is given', () => {
    expect(isNevadaZip('89117')).toBe(true)
    expect(isNevadaZip('89501')).toBe(true)
    expect(isNevadaZip('90210')).toBe(false)
    expect(leadArea({ zip_code: '89117' })).toEqual({ state: 'NV', source: 'zip', outOfArea: false })
    expect(leadArea({ zip: '85001' })).toEqual({ state: null, source: 'zip', outOfArea: true })
  })

  it('unknown location is NOT flagged (a missing answer never mutes a local lead)', () => {
    expect(leadArea({})).toEqual({ state: null, source: null, outOfArea: false })
    expect(leadArea({ state: '??' }).outOfArea).toBe(false)
  })
})

describe('profile rows', () => {
  it('renders stored attribution as readable rows', () => {
    const stored = storedAttribution({
      leadgenId: 'lg_1',
      attribution: leadFromGraphResponse(graphLead).attribution,
      pageId: 'p1',
      area: leadArea({ state: 'CA' }),
      now: new Date('2026-10-07T16:00:00Z'),
    })
    expect(stored.outOfArea).toBe(true)
    // P0-A (changed for review): Graph-supplied names are never stored; ids stay.
    expect([stored.campaignName, stored.adsetName, stored.adName]).toEqual([null, null, null])
    expect([stored.campaignId, stored.adsetId, stored.adId]).toEqual(['333', '222', '111'])
    // Names come only from synced, allowed rows, passed in at read time.
    const rows = Object.fromEntries(
      attributionRows(stored, { campaignName: 'Q4 Review', adsetName: 'LV 35+', adName: 'Video A' }).map((r) => [r.label, r.value]),
    )
    expect(rows.Platform).toBe('Instagram')
    expect(rows.Campaign).toBe('Q4 Review (333)')
    expect(rows['Ad set']).toBe('LV 35+ (222)')
    expect(rows.Ad).toBe('Video A (111)')
    expect(rows.Form).toBe('444')
    expect(rows.Organic).toBe('No (paid)')
    expect(rows['Lead state']).toBe('CA')
  })

  it('fails closed: no names given means no Campaign / Ad set / Ad rows', () => {
    const stored = storedAttribution({ leadgenId: 'lg_1', attribution: leadFromGraphResponse(graphLead).attribution, area: leadArea({}) })
    const labels = attributionRows(stored).map((r) => r.label)
    expect(labels).not.toContain('Campaign')
    expect(labels).not.toContain('Ad set')
    expect(labels).not.toContain('Ad')
    expect(labels).toContain('Platform')
  })

  it('only resolved ids show; nothing resolved reads "Not matched to an ad yet", with no id', () => {
    const stored = storedAttribution({ leadgenId: 'lg_1', attribution: leadFromGraphResponse(graphLead).attribution, area: leadArea({}) })
    const partial = attributionRows(stored, { campaignName: 'Q4 Review', adsetName: null, adName: null })
    expect(partial.filter((r) => ['Campaign', 'Ad set', 'Ad'].includes(r.label))).toEqual([{ label: 'Campaign', value: 'Q4 Review (333)' }])
    // Not bound, not synced or still being checked is NOT "outside".
    const none = attributionRows(stored, { campaignName: null, adsetName: null, adName: null })
    expect(none.filter((r) => ['Campaign', 'Ad set', 'Ad'].includes(r.label))).toEqual([{ label: 'Ad', value: 'Not matched to an ad yet' }])
    expect(JSON.stringify(none)).not.toMatch(/111|222|333/)
  })

  it('"Outside the connected ad account" only when proven, and never with an id', () => {
    const stored = storedAttribution({ leadgenId: 'lg_1', attribution: leadFromGraphResponse(graphLead).attribution, area: leadArea({}) })
    const rows = attributionRows(stored, { campaignName: null, adsetName: null, adName: null, outside: true })
    expect(rows.filter((r) => ['Campaign', 'Ad set', 'Ad'].includes(r.label))).toEqual([{ label: 'Ad', value: 'Outside the connected ad account' }])
    expect(JSON.stringify(rows)).not.toMatch(/111|222|333/)
  })

  it('ignores malformed or non-Meta blobs', () => {
    expect(attributionRows(null)).toEqual([])
    expect(attributionRows([])).toEqual([])
    expect(attributionRows({ provider: 'google' })).toEqual([])
  })
})

describe('preview fixture mode guard', () => {
  it('is off unless explicitly enabled', () => {
    expect(metaFixtureModeEnabled({ VERCEL_ENV: 'preview' })).toBe(false)
  })
  it('is on for a Vercel preview with the flag', () => {
    expect(metaFixtureModeEnabled({ META_FIXTURE_LEADS: 'true', VERCEL_ENV: 'preview', APP_URL: 'https://x-git-y.vercel.app' })).toBe(true)
  })
  it('can never run in production', () => {
    expect(metaFixtureModeEnabled({ META_FIXTURE_LEADS: 'true', VERCEL_ENV: 'production' })).toBe(false)
    expect(metaFixtureModeEnabled({ META_FIXTURE_LEADS: 'true', VERCEL_ENV: 'preview', APP_URL: 'https://prodigyflo.ai' })).toBe(false)
    expect(metaFixtureModeEnabled({ META_FIXTURE_LEADS: 'true', VERCEL_ENV: 'preview', AUTH_URL: 'https://www.prodigyflo.ai/' })).toBe(false)
    expect(metaFixtureModeEnabled({ META_FIXTURE_LEADS: 'true', NODE_ENV: 'production' })).toBe(false)
  })
  it('reads the mocked Graph lead and insists it matches the leadgen id', () => {
    const lead = fixtureLeadFrom({ fixture_lead: graphLead }, 'lg_1')
    expect(lead.attribution.campaignId).toBe('333')
    expect(lead.attribution.campaignName).toBeNull()
    expect(() => fixtureLeadFrom({ fixture_lead: graphLead }, 'other')).toThrow(/must equal/)
    expect(() => fixtureLeadFrom({}, 'lg_1')).toThrow(/no fixture_lead/)
  })
})
