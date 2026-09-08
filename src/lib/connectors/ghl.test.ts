import { describe, expect, it } from 'vitest'
import { connectorDef } from '@/lib/connectors/catalog'
import { applyMapping, missingRequiredFields } from '@/lib/intake/mapping'
import { classifyInbound } from '@/lib/inbound/classify'
import {
  GHL_API_VERSION,
  GHL_PAGE_LIMIT,
  contactsUrl,
  createGhlClient,
  extractContactsPage,
  extractOpportunitiesPage,
  ghlErrorMessage,
  ghlHeaders,
  initialGhlImportState,
  mergeGhlImportState,
  normalizeContact,
  normalizeOpportunity,
  opportunitiesUrl,
  parseGhlImportState,
  type GhlFetch,
  type GhlImportState,
} from '@/lib/connectors/ghl'

// ── Catalog def (the vault card + status flip key off exactly this shape) ─────

describe('gohighlevel-api catalog def', () => {
  it('is an available outbound CRM def backed by the GO_HIGH_LEVEL connector kind', () => {
    const def = connectorDef('gohighlevel-api')!
    expect(def).toBeTruthy()
    expect(def.category).toBe('CRM')
    expect(def.direction).toBe('outbound')
    expect(def.auth).toBe('api-key')
    expect(def.availability).toBe('available')
    expect(def.backing).toEqual({ model: 'connector', kind: 'GO_HIGH_LEVEL' })
  })

  it('declares exactly the apiToken (secret) + locationId credential fields', () => {
    const def = connectorDef('gohighlevel-api')!
    expect(def.credentialFields).toEqual([
      expect.objectContaining({ key: 'apiToken', secret: true }),
      expect.objectContaining({ key: 'locationId', secret: false }),
    ])
  })
})

// ── Request builders ──────────────────────────────────────────────────────────

describe('request builders', () => {
  it('builds the contacts URL with locationId, limit and optional cursor', () => {
    const first = new URL(contactsUrl('loc-1', null))
    expect(first.origin).toBe('https://services.leadconnectorhq.com')
    expect(first.pathname).toBe('/contacts/')
    expect(first.searchParams.get('locationId')).toBe('loc-1')
    expect(first.searchParams.get('limit')).toBe(String(GHL_PAGE_LIMIT))
    expect(first.searchParams.has('startAfterId')).toBe(false)

    const next = new URL(contactsUrl('loc-1', 'abc123'))
    expect(next.searchParams.get('startAfterId')).toBe('abc123')
  })

  it('builds the opportunities search URL with location_id, limit and page', () => {
    const url = new URL(opportunitiesUrl('loc-9', 3))
    expect(url.pathname).toBe('/opportunities/search')
    expect(url.searchParams.get('location_id')).toBe('loc-9')
    expect(url.searchParams.get('limit')).toBe(String(GHL_PAGE_LIMIT))
    expect(url.searchParams.get('page')).toBe('3')
    // Garbage pages clamp to 1 instead of building a broken request.
    expect(new URL(opportunitiesUrl('loc-9', 0)).searchParams.get('page')).toBe('1')
  })

  it('sends the Bearer token and pinned API version headers', () => {
    expect(ghlHeaders('pit-token')).toEqual({
      Authorization: 'Bearer pit-token',
      Version: GHL_API_VERSION,
      Accept: 'application/json',
    })
  })
})

// ── Contacts paging ───────────────────────────────────────────────────────────

const contact = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('extractContactsPage', () => {
  it('follows meta.startAfterId while nextPageUrl says there is more', () => {
    const page = extractContactsPage({
      contacts: [contact('a'), contact('b')],
      meta: { total: 250, startAfterId: 'b', nextPageUrl: 'https://…/contacts/?startAfterId=b' },
    })
    expect(page.contacts.map((c) => c.id)).toEqual(['a', 'b'])
    expect(page.nextCursor).toBe('b')
    expect(page.total).toBe(250)
  })

  it('stops when meta.nextPageUrl is null — even with a startAfterId present', () => {
    const page = extractContactsPage({
      contacts: [contact('z')],
      meta: { startAfterId: 'z', nextPageUrl: null },
    })
    expect(page.nextCursor).toBeNull()
  })

  it('falls back to last-id paging when meta is absent and the page is full', () => {
    const full = Array.from({ length: GHL_PAGE_LIMIT }, (_, i) => contact(`c${i}`))
    expect(extractContactsPage({ contacts: full }).nextCursor).toBe(`c${GHL_PAGE_LIMIT - 1}`)
    expect(extractContactsPage({ contacts: [contact('only')] }).nextCursor).toBeNull()
  })

  it('terminates on an empty page and survives garbage bodies', () => {
    expect(extractContactsPage({ contacts: [], meta: { startAfterId: 'x', nextPageUrl: 'u' } }).nextCursor).toBeNull()
    expect(extractContactsPage(null)).toEqual({ contacts: [], nextCursor: null, total: null })
    expect(extractContactsPage({ contacts: 'nope' }).contacts).toEqual([])
    // Rows without a string id are dropped, not crashed on.
    expect(extractContactsPage({ contacts: [{ email: 'no-id@x.com' }, contact('ok')] }).contacts.map((c) => c.id)).toEqual(['ok'])
  })
})

// ── Opportunities paging ──────────────────────────────────────────────────────

describe('extractOpportunitiesPage', () => {
  it('follows meta.nextPage and stops when it is null or not forward', () => {
    const body = (nextPage: unknown) => ({ opportunities: [{ id: 'o1' }], meta: { total: 7, nextPage } })
    expect(extractOpportunitiesPage(body(2), 1).nextPage).toBe(2)
    expect(extractOpportunitiesPage(body(null), 1).nextPage).toBeNull()
    expect(extractOpportunitiesPage(body(1), 1).nextPage).toBeNull()
    expect(extractOpportunitiesPage(body(2), 1).total).toBe(7)
  })

  it('falls back to page+1 on a full page without meta', () => {
    const full = Array.from({ length: GHL_PAGE_LIMIT }, (_, i) => ({ id: `o${i}` }))
    expect(extractOpportunitiesPage({ opportunities: full }, 4).nextPage).toBe(5)
    expect(extractOpportunitiesPage({ opportunities: [{ id: 'o' }] }, 4).nextPage).toBeNull()
    expect(extractOpportunitiesPage({ opportunities: [] }, 1).nextPage).toBeNull()
  })

  it('pulls contactId from the nested contact when the flat field is missing', () => {
    const page = extractOpportunitiesPage({ opportunities: [{ id: 'o1', contact: { id: 'c9' } }] }, 1)
    expect(page.opportunities[0].contactId).toBe('c9')
  })
})

// ── normalizeContact → the webhook-preset key vocabulary ──────────────────────

describe('normalizeContact', () => {
  it('maps API camelCase onto the exact webhook-preset snake_case keys', () => {
    const normalized = normalizeContact({
      id: 'aBc123XyZ',
      firstName: 'Jane',
      lastName: 'Doe',
      contactName: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+17025551234',
      tags: ['solar', 'inbound'],
      source: 'Facebook Lead Form',
      city: 'Las Vegas',
      postalCode: '89123',
    })
    expect(normalized).toMatchObject({
      contact_id: 'aBc123XyZ',
      first_name: 'Jane',
      last_name: 'Doe',
      full_name: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+17025551234',
      tags: ['solar', 'inbound'],
      source: 'Facebook Lead Form',
      city: 'Las Vegas',
      postal_code: '89123',
    })
  })

  it('feeds the gohighlevel webhook field preset — one mapping serves both paths', () => {
    const def = connectorDef('gohighlevel')!
    const normalized = normalizeContact({
      id: 'c1',
      firstName: 'Sam',
      lastName: 'Rivera',
      email: 's@example.com',
      phone: '+17025550100',
    })
    const { mapped } = applyMapping(def.fieldPreset as Record<string, string>, normalized)
    expect(mapped).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', email: 's@example.com', phone: '+17025550100' })
    expect(missingRequiredFields(mapped)).toEqual([])
  })

  it('splits contactName into first/last when the API sends only the combined name', () => {
    const normalized = normalizeContact({ id: 'c2', contactName: 'Ana Maria Perez', email: 'a@x.com' })
    expect(normalized.first_name).toBe('Ana')
    expect(normalized.last_name).toBe('Maria Perez')
  })

  it('omits missing values instead of emitting empty strings', () => {
    const normalized = normalizeContact({ id: 'c3', firstName: 'Solo', email: '', tags: [] })
    expect(normalized).toEqual({ contact_id: 'c3', first_name: 'Solo' })
  })
})

// ── normalizeOpportunity → an OPPORTUNITY-classified payload ──────────────────

describe('normalizeOpportunity', () => {
  it('produces a payload the inbound classifier files under OPPORTUNITY', () => {
    const payload = normalizeOpportunity({
      id: 'opp-1',
      name: 'Jane Doe — Solar Exit',
      status: 'open',
      monetaryValue: 2500,
      pipelineId: 'p1',
      pipelineStageId: 's2',
      contactId: 'c1',
    })
    expect(payload).toMatchObject({
      event_type: 'opportunity',
      opportunity_id: 'opp-1',
      contact_id: 'c1',
      monetary_value: 2500,
      status: 'open',
    })
    const classified = classifyInbound(payload)
    expect(classified.category).toBe('OPPORTUNITY')
    expect(classified.document).toBeNull()
  })
})

// ── Resume-state round-trip through Connector.config ──────────────────────────

describe('import resume state', () => {
  it('round-trips through a Connector.config value without losing anything', () => {
    const state: GhlImportState = {
      phase: 'opportunities',
      contactCursor: 'cursor-final',
      opportunityPage: 12,
      contacts: { imported: 480, duplicates: 19, failed: 3 },
      opportunities: { imported: 55, duplicates: 2, failed: 1 },
      startedAt: '2026-08-28T10:00:00.000Z',
      finishedAt: null,
    }
    const config = mergeGhlImportState({ otherFeature: { keep: true } }, state)
    expect(parseGhlImportState(config)).toEqual(state)
    // Foreign config keys survive the merge untouched.
    expect(config.otherFeature).toEqual({ keep: true })
  })

  it('round-trips a completed run', () => {
    const done: GhlImportState = {
      ...initialGhlImportState(new Date('2026-08-28T10:00:00Z')),
      phase: 'done',
      finishedAt: '2026-08-28T10:05:00.000Z',
    }
    expect(parseGhlImportState(mergeGhlImportState({}, done))).toEqual(done)
  })

  it('returns null for absent or corrupted state (caller starts fresh)', () => {
    expect(parseGhlImportState(null)).toBeNull()
    expect(parseGhlImportState({})).toBeNull()
    expect(parseGhlImportState({ ghlImport: 'garbage' })).toBeNull()
    expect(parseGhlImportState({ ghlImport: { phase: 'warp-speed' } })).toBeNull()
  })

  it('sanitizes malformed counts and page numbers instead of trusting them', () => {
    const parsed = parseGhlImportState({
      ghlImport: {
        phase: 'contacts',
        contactCursor: 42, // not a string → dropped
        opportunityPage: -3,
        contacts: { imported: 'many', duplicates: 2.9, failed: -1 },
        opportunities: null,
      },
    })
    expect(parsed).toEqual({
      phase: 'contacts',
      contactCursor: null,
      opportunityPage: 1,
      contacts: { imported: 0, duplicates: 2, failed: 0 },
      opportunities: { imported: 0, duplicates: 0, failed: 0 },
      startedAt: null,
      finishedAt: null,
    })
  })

  it('starts at the contacts phase with zeroed counts', () => {
    const state = initialGhlImportState(new Date('2026-08-28T00:00:00Z'))
    expect(state.phase).toBe('contacts')
    expect(state.contactCursor).toBeNull()
    expect(state.opportunityPage).toBe(1)
    expect(state.contacts).toEqual({ imported: 0, duplicates: 0, failed: 0 })
    expect(state.startedAt).toBe('2026-08-28T00:00:00.000Z')
  })
})

// ── The client with an injected fetch ─────────────────────────────────────────

function fakeFetch(handler: (url: string) => { status: number; body: string }): { impl: GhlFetch; calls: string[] } {
  const calls: string[] = []
  const impl: GhlFetch = async (url) => {
    calls.push(url)
    const { status, body } = handler(url)
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { impl, calls }
}

describe('createGhlClient', () => {
  it('lists contacts with auth headers and parses the page', async () => {
    let seenHeaders: Record<string, string> | undefined
    const impl: GhlFetch = async (url, init) => {
      seenHeaders = init?.headers
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ contacts: [{ id: 'c1', firstName: 'Jane' }], meta: { startAfterId: 'c1', nextPageUrl: 'next' } }),
      }
    }
    const client = createGhlClient({ apiToken: 'pit-secret', fetchImpl: impl })
    const page = await client.listContacts('loc-1', null)
    expect(page.contacts).toHaveLength(1)
    expect(page.nextCursor).toBe('c1')
    expect(seenHeaders?.Authorization).toBe('Bearer pit-secret')
    expect(seenHeaders?.Version).toBe(GHL_API_VERSION)
  })

  it('throws an honest error naming the HTTP status — 401 names the token', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: JSON.stringify({ message: 'Invalid JWT' }) }))
    const client = createGhlClient({ apiToken: 'pit-bad', fetchImpl: impl })
    await expect(client.listContacts('loc-1', null)).rejects.toThrow(/HTTP 401[\s\S]*token[\s\S]*Invalid JWT/)
  })

  it('reports rate limiting and non-JSON bodies without crashing', async () => {
    const limited = createGhlClient({
      apiToken: 't',
      fetchImpl: fakeFetch(() => ({ status: 429, body: 'slow down' })).impl,
    })
    await expect(limited.searchOpportunities('loc', 1)).rejects.toThrow(/HTTP 429/)

    const htmlBody = createGhlClient({
      apiToken: 't',
      fetchImpl: fakeFetch(() => ({ status: 200, body: '<html>gateway</html>' })).impl,
    })
    await expect(htmlBody.listContacts('loc', null)).rejects.toThrow(/not valid JSON/)
  })

  it('wraps network failures in a resumable-sounding message', async () => {
    const impl: GhlFetch = async () => {
      throw new Error('ECONNRESET')
    }
    const client = createGhlClient({ apiToken: 't', fetchImpl: impl })
    await expect(client.listContacts('loc', null)).rejects.toThrow(/Could not reach GoHighLevel.*progress is saved/)
  })
})

describe('ghlErrorMessage', () => {
  it('names the status and the likely cause without ever echoing credentials', () => {
    expect(ghlErrorMessage(401)).toMatch(/401.*token/)
    expect(ghlErrorMessage(403)).toMatch(/403.*scope/)
    expect(ghlErrorMessage(404)).toMatch(/404.*Location ID/)
    expect(ghlErrorMessage(429)).toMatch(/429.*resume/)
    expect(ghlErrorMessage(503)).toMatch(/503/)
    expect(ghlErrorMessage(418)).toBe('GoHighLevel request failed (HTTP 418).')
  })

  it('appends a trimmed server detail when one exists', () => {
    expect(ghlErrorMessage(422, '  locationId is required ')).toMatch(/422.*locationId is required/)
  })
})
