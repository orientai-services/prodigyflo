/**
 * GoHighLevel (LeadConnector) API v2 client + the pure logic around it:
 * request builders, defensive page extractors, payload normalizers and the
 * resumable import-state (de)serialization.
 *
 * Deliberately NOT `server-only` and free of db/rbac imports — everything here
 * except `createGhlClient`'s network calls is pure, so the paging, normalizing
 * and resume-state rules are unit-testable and the types are safe to import
 * from client components. The orchestration that touches the database lives in
 * `ghl-import.ts`; the API token only ever passes through `createGhlClient`
 * and is never logged, thrown, or serialized by anything in this module.
 */

export const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
export const GHL_API_VERSION = '2021-07-28'
export const GHL_PAGE_LIMIT = 100

// ── Shapes (defensively parsed — GHL fields we rely on, everything optional) ──

export type GhlContact = {
  id: string
  firstName?: string | null
  lastName?: string | null
  contactName?: string | null
  email?: string | null
  phone?: string | null
  tags?: string[]
  source?: string | null
  address1?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  country?: string | null
  dateAdded?: string | null
}

export type GhlOpportunity = {
  id: string
  name?: string | null
  status?: string | null
  monetaryValue?: number | null
  pipelineId?: string | null
  pipelineStageId?: string | null
  contactId?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type GhlContactsPage = {
  contacts: GhlContact[]
  /** Cursor for the next page (meta.startAfterId / last id), or null when done. */
  nextCursor: string | null
  total: number | null
}

export type GhlOpportunitiesPage = {
  opportunities: GhlOpportunity[]
  /** 1-based page number to fetch next, or null when done. */
  nextPage: number | null
  total: number | null
}

// ── Request builders (pure) ───────────────────────────────────────────────────

export function ghlHeaders(apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    Version: GHL_API_VERSION,
    Accept: 'application/json',
  }
}

export function contactsUrl(locationId: string, cursor: string | null = null, baseUrl = GHL_BASE_URL): string {
  const url = new URL('/contacts/', baseUrl)
  url.searchParams.set('locationId', locationId)
  url.searchParams.set('limit', String(GHL_PAGE_LIMIT))
  if (cursor) url.searchParams.set('startAfterId', cursor)
  return url.toString()
}

export function opportunitiesUrl(locationId: string, page: number, baseUrl = GHL_BASE_URL): string {
  const url = new URL('/opportunities/search', baseUrl)
  url.searchParams.set('location_id', locationId)
  url.searchParams.set('limit', String(GHL_PAGE_LIMIT))
  url.searchParams.set('page', String(Math.max(1, Math.trunc(page) || 1)))
  return url.toString()
}

// ── Honest error text (never includes the token or the URL) ───────────────────

export function ghlErrorMessage(status: number, detail?: string | null): string {
  const base =
    status === 401
      ? 'GoHighLevel rejected the request (HTTP 401) — the Private Integration token is invalid or was revoked.'
      : status === 403
        ? 'GoHighLevel refused the request (HTTP 403) — the token is missing the Contacts/Opportunities view scopes.'
        : status === 404
          ? 'GoHighLevel returned HTTP 404 — check the Location ID; that location was not found.'
          : status === 422
            ? 'GoHighLevel returned HTTP 422 — the request parameters were rejected (is the Location ID correct?).'
            : status === 429
              ? 'GoHighLevel rate limit hit (HTTP 429) — wait a moment and resume; progress is saved.'
              : status >= 500
                ? `GoHighLevel is having trouble (HTTP ${status}) — resume in a minute; progress is saved.`
                : `GoHighLevel request failed (HTTP ${status}).`
  const extra = (detail ?? '').trim().slice(0, 200)
  return extra ? `${base} ${extra}` : base
}

// ── Defensive page extractors (pure) ──────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

function optNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseContact(v: unknown): GhlContact | null {
  if (!isRecord(v)) return null
  const id = optString(v.id)
  if (!id) return null
  return {
    id,
    firstName: optString(v.firstName),
    lastName: optString(v.lastName),
    contactName: optString(v.contactName),
    email: optString(v.email),
    phone: optString(v.phone),
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : undefined,
    source: optString(v.source),
    address1: optString(v.address1),
    city: optString(v.city),
    state: optString(v.state),
    postalCode: optString(v.postalCode),
    country: optString(v.country),
    dateAdded: optString(v.dateAdded),
  }
}

/**
 * Parse a GET /contacts/ response body. Paging follows `meta.startAfterId` /
 * `meta.nextPageUrl` when GHL sends them; when meta is absent we fall back to
 * "a full page means there is probably more" with the last contact id as the
 * cursor (an extra empty fetch at the end is harmless — it terminates).
 */
export function extractContactsPage(body: unknown, limit = GHL_PAGE_LIMIT): GhlContactsPage {
  if (!isRecord(body)) return { contacts: [], nextCursor: null, total: null }
  const rawList = Array.isArray(body.contacts) ? body.contacts : []
  const contacts = rawList.map(parseContact).filter((c): c is GhlContact => c !== null)
  const meta = isRecord(body.meta) ? body.meta : null
  const total = optNumber(meta?.total) ?? optNumber(body.count) ?? optNumber(body.total)

  if (contacts.length === 0) return { contacts, nextCursor: null, total }

  const lastId = contacts[contacts.length - 1].id
  const metaCursor = optString(meta?.startAfterId)
  let nextCursor: string | null = null
  if (meta && 'nextPageUrl' in meta) {
    // meta speaks authoritatively: an empty/null nextPageUrl means done.
    nextCursor = optString(meta.nextPageUrl) ? (metaCursor ?? lastId) : null
  } else if (metaCursor) {
    nextCursor = metaCursor
  } else if (rawList.length >= limit) {
    nextCursor = lastId
  }
  return { contacts, nextCursor, total }
}

function parseOpportunity(v: unknown): GhlOpportunity | null {
  if (!isRecord(v)) return null
  const id = optString(v.id)
  if (!id) return null
  const contact = isRecord(v.contact) ? v.contact : null
  return {
    id,
    name: optString(v.name),
    status: optString(v.status),
    monetaryValue: optNumber(v.monetaryValue),
    pipelineId: optString(v.pipelineId),
    pipelineStageId: optString(v.pipelineStageId),
    contactId: optString(v.contactId) ?? optString(contact?.id),
    createdAt: optString(v.createdAt),
    updatedAt: optString(v.updatedAt),
  }
}

/** Parse a GET /opportunities/search response body; paging via `meta.nextPage`. */
export function extractOpportunitiesPage(body: unknown, page: number, limit = GHL_PAGE_LIMIT): GhlOpportunitiesPage {
  if (!isRecord(body)) return { opportunities: [], nextPage: null, total: null }
  const rawList = Array.isArray(body.opportunities) ? body.opportunities : []
  const opportunities = rawList.map(parseOpportunity).filter((o): o is GhlOpportunity => o !== null)
  const meta = isRecord(body.meta) ? body.meta : null
  const total = optNumber(meta?.total) ?? optNumber(body.total)

  if (opportunities.length === 0) return { opportunities, nextPage: null, total }

  let nextPage: number | null = null
  const metaNext = optNumber(meta?.nextPage)
  if (meta && 'nextPage' in meta) {
    nextPage = metaNext !== null && metaNext > page ? metaNext : null
  } else if (rawList.length >= limit) {
    nextPage = page + 1
  }
  return { opportunities, nextPage, total }
}

// ── Normalizers (pure): API camelCase → the webhook-preset snake_case keys ────

/**
 * Reshape an API contact into the exact key vocabulary the GoHighLevel WEBHOOK
 * sends (`contact_id`, `first_name`, …) so the one stored fieldMapping on the
 * org's gohighlevel IntakeSource serves both the webhook and this importer.
 * Missing values are omitted (never empty strings) so merge-fill and
 * NEEDS_MAPPING behave exactly as they do for webhook deliveries.
 */
export function normalizeContact(contact: GhlContact): Record<string, unknown> {
  // A contact with only a combined name still becomes importable: split on the
  // last space, the same shape a webhook's full_name-only payload would need.
  let firstName = contact.firstName ?? null
  let lastName = contact.lastName ?? null
  if (!firstName && !lastName && contact.contactName) {
    const parts = contact.contactName.trim().split(/\s+/)
    firstName = parts[0] ?? null
    lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
  }

  const out: Record<string, unknown> = { contact_id: contact.id }
  const put = (key: string, value: unknown) => {
    if (value === null || value === undefined) return
    if (typeof value === 'string' && value.trim() === '') return
    if (Array.isArray(value) && value.length === 0) return
    out[key] = value
  }
  put('first_name', firstName)
  put('last_name', lastName)
  put('full_name', contact.contactName)
  put('email', contact.email)
  put('phone', contact.phone)
  put('tags', contact.tags)
  put('source', contact.source)
  put('address_line_1', contact.address1)
  put('city', contact.city)
  put('state', contact.state)
  put('postal_code', contact.postalCode)
  put('country', contact.country)
  put('date_added', contact.dateAdded)
  return out
}

/**
 * Reshape an API opportunity into a webhook-style payload the inbound
 * classifier files under OPPORTUNITY (`event_type: 'opportunity'`).
 */
export function normalizeOpportunity(opp: GhlOpportunity): Record<string, unknown> {
  const out: Record<string, unknown> = { event_type: 'opportunity', opportunity_id: opp.id }
  if (opp.name) out.name = opp.name
  if (opp.status) out.status = opp.status
  if (opp.monetaryValue !== null && opp.monetaryValue !== undefined) out.monetary_value = opp.monetaryValue
  if (opp.pipelineId) out.pipeline_id = opp.pipelineId
  if (opp.pipelineStageId) out.pipeline_stage_id = opp.pipelineStageId
  if (opp.contactId) out.contact_id = opp.contactId
  if (opp.createdAt) out.created_at = opp.createdAt
  if (opp.updatedAt) out.updated_at = opp.updatedAt
  return out
}

// ── Resumable import state (pure round-trip through Connector.config) ─────────

export type GhlPhaseCounts = { imported: number; duplicates: number; failed: number }

export type GhlImportPhase = 'contacts' | 'opportunities' | 'done'

export type GhlImportState = {
  phase: GhlImportPhase
  /** Contact paging cursor — null means "start from the beginning". */
  contactCursor: string | null
  /** 1-based opportunities page to fetch next. */
  opportunityPage: number
  contacts: GhlPhaseCounts
  opportunities: GhlPhaseCounts
  startedAt: string | null
  finishedAt: string | null
}

const CONFIG_KEY = 'ghlImport'

export function zeroCounts(): GhlPhaseCounts {
  return { imported: 0, duplicates: 0, failed: 0 }
}

export function initialGhlImportState(now: Date = new Date()): GhlImportState {
  return {
    phase: 'contacts',
    contactCursor: null,
    opportunityPage: 1,
    contacts: zeroCounts(),
    opportunities: zeroCounts(),
    startedAt: now.toISOString(),
    finishedAt: null,
  }
}

function parseCounts(v: unknown): GhlPhaseCounts {
  if (!isRecord(v)) return zeroCounts()
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0)
  return { imported: n(v.imported), duplicates: n(v.duplicates), failed: n(v.failed) }
}

/**
 * Read the persisted import state back out of a Connector.config value.
 * Returns null when nothing (or garbage) is stored — the caller starts fresh.
 */
export function parseGhlImportState(config: unknown): GhlImportState | null {
  if (!isRecord(config)) return null
  const raw = config[CONFIG_KEY]
  if (!isRecord(raw)) return null
  const phase = raw.phase
  if (phase !== 'contacts' && phase !== 'opportunities' && phase !== 'done') return null
  const page = optNumber(raw.opportunityPage)
  return {
    phase,
    contactCursor: optString(raw.contactCursor),
    opportunityPage: page !== null && page >= 1 ? Math.trunc(page) : 1,
    contacts: parseCounts(raw.contacts),
    opportunities: parseCounts(raw.opportunities),
    startedAt: optString(raw.startedAt),
    finishedAt: optString(raw.finishedAt),
  }
}

/**
 * Merge the import state into an existing Connector.config value without
 * disturbing any other keys the config carries.
 */
export function mergeGhlImportState(config: unknown, state: GhlImportState): Record<string, unknown> {
  const base = isRecord(config) ? { ...config } : {}
  base[CONFIG_KEY] = {
    phase: state.phase,
    contactCursor: state.contactCursor,
    opportunityPage: state.opportunityPage,
    contacts: { ...state.contacts },
    opportunities: { ...state.opportunities },
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  }
  return base
}

// ── The HTTP client (injectable fetch; the only impure corner of this module) ─

export type GhlFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export type GhlClient = {
  listContacts(locationId: string, cursor: string | null): Promise<GhlContactsPage>
  searchOpportunities(locationId: string, page: number): Promise<GhlOpportunitiesPage>
}

export function createGhlClient(opts: {
  apiToken: string
  fetchImpl?: GhlFetch
  baseUrl?: string
}): GhlClient {
  const fetchImpl: GhlFetch = opts.fetchImpl ?? (fetch as unknown as GhlFetch)
  const baseUrl = opts.baseUrl ?? GHL_BASE_URL
  const headers = ghlHeaders(opts.apiToken)

  async function request(url: string): Promise<unknown> {
    let res: Awaited<ReturnType<GhlFetch>>
    try {
      res = await fetchImpl(url, { headers })
    } catch (e) {
      throw new Error(
        `Could not reach GoHighLevel${e instanceof Error && e.message ? ` (${e.message.slice(0, 120)})` : ''} — check connectivity and resume; progress is saved.`,
      )
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      let detail: string | null = null
      try {
        const parsed = JSON.parse(text) as unknown
        if (isRecord(parsed)) {
          const m = parsed.message
          detail = typeof m === 'string' ? m : Array.isArray(m) ? m.filter((x) => typeof x === 'string').join('; ') : null
        }
      } catch {
        // Non-JSON error body — the status-derived message stands on its own.
      }
      throw new Error(ghlErrorMessage(res.status, detail))
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('GoHighLevel returned a response that is not valid JSON.')
    }
  }

  return {
    async listContacts(locationId, cursor) {
      return extractContactsPage(await request(contactsUrl(locationId, cursor, baseUrl)))
    },
    async searchOpportunities(locationId, page) {
      return extractOpportunitiesPage(await request(opportunitiesUrl(locationId, page, baseUrl)), page)
    },
  }
}
