import { describe, expect, it } from 'vitest'
import { connectorDef } from '@/lib/connectors/catalog'
import { testMapping, testMappingCore } from '@/lib/connectors/provision'
import { deriveExternalId } from '@/lib/intake/external-id'

describe('testMapping', () => {
  it('maps a GoHighLevel payload through the def preset (empty mapping falls back)', () => {
    const def = connectorDef('gohighlevel')!
    const res = testMapping('gohighlevel', {}, JSON.stringify(def.samplePayload))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mapped).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      phone: '+17025551234',
    })
    expect(res.missingRequired).toEqual([])
    // Keys present in the payload but not consumed by the mapping are surfaced.
    expect(res.unmappedKeys).toEqual(expect.arrayContaining(['contact_id', 'full_name', 'source', 'tags']))
    expect(res.unmappedKeys).not.toContain('email')
  })

  it('honors an explicit mapping over the def preset', () => {
    const res = testMapping(
      'generic-webhook',
      { firstName: 'fname', email: 'contact.email' },
      JSON.stringify({ fname: 'Sam', contact: { email: 'sam@example.com' } }),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.mapped.firstName).toBe('Sam')
    expect(res.mapped.email).toBe('sam@example.com')
  })

  it('reports missing required fields when contact info is absent', () => {
    const res = testMapping('generic-webhook', { firstName: 'a', lastName: 'b' }, JSON.stringify({ a: 'Al', b: 'Bo' }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.missingRequired).toContain('email or phone')
  })

  it('rejects invalid JSON', () => {
    const res = testMapping('gohighlevel', {}, '{not json')
    expect(res).toEqual({ ok: false, error: 'Payload is not valid JSON.' })
  })

  it('rejects a non-object payload (array / scalar)', () => {
    expect(testMapping('gohighlevel', {}, '[1,2,3]')).toEqual({ ok: false, error: 'Payload must be a JSON object.' })
    expect(testMapping('gohighlevel', {}, '"hello"')).toEqual({ ok: false, error: 'Payload must be a JSON object.' })
  })
})

describe('testMappingCore', () => {
  it('accepts a raw mapping and a parsed object, resolving dot-paths', () => {
    const out = testMappingCore(
      { firstName: 'first', email: 'data.email' },
      { first: 'Ada', data: { email: 'ada@example.com' } },
    )
    expect(out.mapped).toEqual({ firstName: 'Ada', email: 'ada@example.com' })
    expect(out.missingRequired).toContain('lastName')
    expect(out.unmappedKeys).toEqual([])
  })
})

describe('deriveExternalId (catalog-aware idempotency)', () => {
  it('prefers the connector def key over generic fallbacks', () => {
    // GoHighLevel: contact_id is the stable id even though a generic `id` is absent.
    const payload = { contact_id: 'aBc123', email: 'j@example.com' }
    expect(deriveExternalId(payload, 'contact_id')).toBe('aBc123')
  })

  it('prefers leadgen_id for Meta payloads', () => {
    expect(deriveExternalId({ leadgen_id: '99887766', id: 'x' }, 'leadgen_id')).toBe('99887766')
  })

  it('falls back to the standard keys when the preferred key is absent', () => {
    expect(deriveExternalId({ id: 'lead-1' }, 'contact_id')).toBe('lead-1')
  })

  it('content-hashes when no id of any kind is present', () => {
    expect(deriveExternalId({ email: 'nobody@example.com' }, 'contact_id')).toMatch(/^sha256:/)
  })

  it('keeps the original single-argument behaviour', () => {
    expect(deriveExternalId({ id: 'z9' })).toBe('z9')
  })
})
