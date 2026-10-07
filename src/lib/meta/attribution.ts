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

/** The Graph fields we ask for on every lead read. */
export const GRAPH_LEAD_FIELDS = [
  'id', 'created_time', 'field_data',
  'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
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
 */
export function attributionFromGraph(
  res: Partial<GraphLeadResponse>,
  webhook: { adId?: string | null; adsetId?: string | null; formId?: string | null } = {},
): MetaLeadAttribution {
  return {
    adId: clean(res.ad_id) ?? clean(webhook.adId),
    adName: clean(res.ad_name),
    adsetId: clean(res.adset_id) ?? clean(webhook.adsetId),
    adsetName: clean(res.adset_name),
    campaignId: clean(res.campaign_id),
    campaignName: clean(res.campaign_name),
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
    state: input.area.state,
    stateSource: input.area.source,
    outOfArea: input.area.outOfArea,
    capturedAt: (input.now ?? new Date()).toISOString(),
  }
}

export type AttributionRow = { label: string; value: string }

function named(name: string | null, id: string | null): string | null {
  if (name && id) return `${name} (${id})`
  return name ?? id
}

/** Profile rows for a stored attribution blob. Anything malformed → []. */
export function attributionRows(raw: unknown): AttributionRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const a = raw as Partial<StoredLeadAttribution>
  if (a.provider !== 'meta') return []
  const s = (v: unknown) => clean(v)
  const platform = a.platform === 'fb' ? 'Facebook' : a.platform === 'ig' ? 'Instagram' : s(a.platform)
  const rows: [string, string | null][] = [
    ['Platform', platform],
    ['Campaign', named(s(a.campaignName), s(a.campaignId))],
    ['Ad set', named(s(a.adsetName), s(a.adsetId))],
    ['Ad', named(s(a.adName), s(a.adId))],
    ['Form', s(a.formId)],
    ['Organic', a.isOrganic === true ? 'Yes' : a.isOrganic === false ? 'No (paid)' : null],
    ['Lead state', a.state ? `${a.state}${a.stateSource === 'zip' ? ' (from ZIP)' : ''}` : null],
    ['Leadgen id', s(a.leadgenId)],
  ]
  return rows.filter((r): r is [string, string] => Boolean(r[1])).map(([label, value]) => ({ label, value }))
}
