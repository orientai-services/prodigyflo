/**
 * Lead source attribution for Meta Lead Ads, plus the service-area flag.
 *
 * Pure helpers (no DB, no network) so the webhook, the Graph adapter, the
 * preview fixture provider and the profile UI all read one shape.
 *
 * Graph's Lead object carries the ad/ad set/campaign/form the lead came from,
 * the platform (fb / ig) and is_organic. The leadgen webhook itself only sends
 * ad_id, adgroup_id (the ad SET id) and form_id, so those are the fallback when
 * Graph leaves a field out.
 */

export type MetaLeadAttribution = {
  adId: string | null
  adName: string | null
  adsetId: string | null
  adsetName: string | null
  campaignId: string | null
  campaignName: string | null
  formId: string | null
  /** 'fb' | 'ig' for Facebook / Instagram. Other Meta surfaces keep their raw code. */
  platform: string | null
  isOrganic: boolean | null
}

/** What Graph returns for GET /{leadgen_id}?fields=... */
export type GraphLeadResponse = {
  id: string
  created_time?: string
  field_data?: { name: string; values?: string[] }[]
  ad_id?: string
  ad_name?: string
  adset_id?: string
  adset_name?: string
  campaign_id?: string
  campaign_name?: string
  form_id?: string
  platform?: string
  is_organic?: boolean | string
}

/**
 * The Graph fields we ask for on every lead read. Ids only: a lead on a shared
 * Page can come from an ad in an ad account ProdigyFlo must never read, so ad,
 * ad set and campaign NAMES are never requested. Names are looked up at read
 * time from synced rows of the approved account (ads/attribution-names.ts).
 */
export const GRAPH_LEAD_FIELDS = [
  'id', 'created_time', 'field_data',
  'ad_id', 'adset_id', 'campaign_id',
  'form_id', 'platform', 'is_organic',
].join(',')

/** Home state for the service area. Leads elsewhere are kept but flagged. */
export const SERVICE_STATE = 'NV'

function clean(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s ? s.slice(0, 200) : null
}

export function normalizePlatform(raw: unknown): string | null {
  const p = clean(raw)?.toLowerCase() ?? null
  if (!p) return null
  if (p === 'fb' || p === 'facebook') return 'fb'
  if (p === 'ig' || p === 'instagram') return 'ig'
  return p.slice(0, 20)
}

function bool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return null
}

/**
 * Merge Graph's lead attribution with the webhook's own ids. Graph wins when it
 * has a value; the webhook ids fill the gaps (ad_id, adgroup_id → adset, form_id).
 * Names are always null, even if a response carries them (see GRAPH_LEAD_FIELDS).
 */
export function attributionFromGraph(
  res: Partial<GraphLeadResponse>,
  webhook: { adId?: string | null; adsetId?: string | null; formId?: string | null } = {},
): MetaLeadAttribution {
  return {
    adId: clean(res.ad_id) ?? clean(webhook.adId),
    adName: null,
    adsetId: clean(res.adset_id) ?? clean(webhook.adsetId),
    adsetName: null,
    campaignId: clean(res.campaign_id),
    campaignName: null,
    formId: clean(res.form_id) ?? clean(webhook.formId),
    platform: normalizePlatform(res.platform),
    isOrganic: bool(res.is_organic),
  }
}

/** Fill attribution gaps from the webhook ids without dropping what Graph gave. */
export function withWebhookIds(
  a: MetaLeadAttribution | undefined,
  webhook: { adId?: string | null; adsetId?: string | null; formId?: string | null },
): MetaLeadAttribution {
  const base = a ?? attributionFromGraph({})
  return {
    ...base,
    adId: base.adId ?? clean(webhook.adId),
    adsetId: base.adsetId ?? clean(webhook.adsetId),
    formId: base.formId ?? clean(webhook.formId),
  }
}

/** Graph lead → our MetaLead shape (fields flattened, attribution attached). */
export function leadFromGraphResponse(res: GraphLeadResponse): {
  leadgenId: string
  createdTime: string
  fields: Record<string, string>
  attribution: MetaLeadAttribution
} {
  if (!res || typeof res.id !== 'string' || !res.id) throw new Error('Graph lead response has no id.')
  return {
    leadgenId: res.id,
    createdTime: res.created_time ?? new Date().toISOString(),
    fields: Object.fromEntries((res.field_data ?? []).map((f) => [f.name, f.values?.[0] ?? ''])),
    attribution: attributionFromGraph(res),
  }
}

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR',
}
const STATE_CODES = new Set(Object.values(STATE_NAMES))

/** "Nevada", "nv", "NV." → "NV". Unknown text → null. */
export function normalizeState(raw: unknown): string | null {
  const s = clean(raw)
  if (!s) return null
  const t = s.replace(/[.\s]+$/g, '').trim()
  if (/^[a-z]{2}$/i.test(t) && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase()
  return STATE_NAMES[t.toLowerCase()] ?? null
}

/** Nevada ZIPs are 889xx–898xx. */
export function isNevadaZip(zip: string): boolean {
  const n = Number(zip.slice(0, 3))
  return n >= 889 && n <= 898
}

export type LeadArea = {
  /** Two-letter state when the form said so, else null. */
  state: string | null
  /** Where the answer came from. */
  source: 'state' | 'zip' | null
  /**
   * True only when we KNOW the lead is outside Nevada. Unknown location stays
   * false, so a missing answer never mutes a real local lead.
   */
  outOfArea: boolean
}

/**
 * Service-area check from Meta form fields. A stated state wins; otherwise a
 * 5-digit ZIP decides NV vs not NV. Nothing usable → unknown, not flagged.
 */
export function leadArea(fields: Record<string, string | undefined>): LeadArea {
  const stated = fields.state ?? fields.province ?? fields.state_province ?? fields.region
  const state = normalizeState(stated)
  if (state) return { state, source: 'state', outOfArea: state !== SERVICE_STATE }
  const zip = (fields.zip_code ?? fields.zip ?? fields.postal_code ?? fields.post_code ?? '').match(/\b\d{5}\b/)?.[0]
  if (zip) {
    const nv = isNevadaZip(zip)
    return { state: nv ? SERVICE_STATE : null, source: 'zip', outOfArea: !nv }
  }
  return { state: null, source: null, outOfArea: false }
}

/** The JSON blob stored on Client.leadAttribution / CallCenterLead.leadAttribution. */
export type StoredLeadAttribution = MetaLeadAttribution & {
  provider: 'meta'
  leadgenId: string
  pageId: string | null
  state: string | null
  stateSource: LeadArea['source']
  outOfArea: boolean
  capturedAt: string
}

export function storedAttribution(input: {
  leadgenId: string
  attribution: MetaLeadAttribution
  pageId?: string | null
  area: LeadArea
  now?: Date
}): StoredLeadAttribution {
  return {
    provider: 'meta',
    leadgenId: input.leadgenId,
    pageId: clean(input.pageId) ?? null,
    ...input.attribution,
    // Ids only. Graph-supplied names can belong to an ad account outside the
    // approved one, so they live in memory for the request and are never
    // stored; names are looked up at read time from synced, allowed rows
    // (src/lib/meta/ads/attribution-names.ts).
    adName: null,
    adsetName: null,
    campaignName: null,
    state: input.area.state,
    stateSource: input.area.source,
    outOfArea: input.area.outOfArea,
    capturedAt: (input.now ?? new Date()).toISOString(),
  }
}

export type AttributionRow = { label: string; value: string }

/**
 * Names for the Campaign / Ad set / Ad rows, resolved server-side from synced
 * rows of the approved ad account only (attributionRowsFor). A null name means
 * that id did not resolve. `outside` is true only when it is PROVEN that the
 * ad belongs to another ad account (the lead's touch is outside, or Meta said
 * the ad is in another account); an id that merely hasn't resolved yet (not
 * synced, not bound, still being checked) is never called outside.
 */
export type AttributionNames = {
  campaignName: string | null
  adsetName: string | null
  adName: string | null
  outside?: boolean
}

export const OUTSIDE_AD_ACCOUNT = 'Outside the connected ad account'
export const NOT_MATCHED_YET = 'Not matched to an ad yet'

/**
 * Profile rows for a stored attribution blob. Anything malformed → [].
 *
 * Campaign, Ad set and Ad appear only with `names`, and only for ids that
 * resolved, as "name (id)". When none resolved: one row with no id, "Ad:
 * Outside the connected ad account" if that is proven, else "Ad: Not matched
 * to an ad yet". Without `names` they never appear (fail closed).
 */
export function attributionRows(raw: unknown, names?: AttributionNames): AttributionRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const a = raw as Partial<StoredLeadAttribution>
  if (a.provider !== 'meta') return []
  const s = (v: unknown) => clean(v)
  const platform = a.platform === 'fb' ? 'Facebook' : a.platform === 'ig' ? 'Instagram' : s(a.platform)
  const ids = { campaign: s(a.campaignId), adset: s(a.adsetId), ad: s(a.adId) }
  const adRows: [string, string | null][] = []
  if (names) {
    const campaign = clean(names.campaignName), adset = clean(names.adsetName), ad = clean(names.adName)
    if (ids.campaign && campaign) adRows.push(['Campaign', `${campaign} (${ids.campaign})`])
    if (ids.adset && adset) adRows.push(['Ad set', `${adset} (${ids.adset})`])
    if (ids.ad && ad) adRows.push(['Ad', `${ad} (${ids.ad})`])
    if (adRows.length === 0 && (ids.campaign || ids.adset || ids.ad)) {
      adRows.push(['Ad', names.outside ? OUTSIDE_AD_ACCOUNT : NOT_MATCHED_YET])
    }
  }
  const rows: [string, string | null][] = [
    ['Platform', platform],
    ...adRows,
    ['Form', s(a.formId)],
    ['Organic', a.isOrganic === true ? 'Yes' : a.isOrganic === false ? 'No (paid)' : null],
    ['Lead state', a.state ? `${a.state}${a.stateSource === 'zip' ? ' (from ZIP)' : ''}` : null],
    ['Leadgen id', s(a.leadgenId)],
  ]
  return rows.filter((r): r is [string, string] => Boolean(r[1])).map(([label, value]) => ({ label, value }))
}
