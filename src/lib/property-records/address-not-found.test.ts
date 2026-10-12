import { describe, it, expect } from 'vitest'
import { addressNotFoundNote, addressVersion, validateRecordsResult } from './contract'

const tried = { line1: '9796 alemnia st', city: 'las vegas', state: 'nv', postal_code: '89178' }
const noMatch = {
  version: 'property-records-v1', case_key: 'scs:t', address_version: addressVersion(tried), address: tried, parcel: null, status: 'no_match', cached: false, originals: [],
  outcomes: [
    { source: 'clark_assessor', kind: 'parcel', status: 'no_match', detail: 'Address not found at county — check spelling. Tried: 9796 alemnia st, las vegas', address_tried: '9796 alemnia st, las vegas, nv' },
    { source: 'records', kind: 'permit', status: 'no_permit_found', reason: 'lookup_failed' },
  ],
}

describe('address not found at county', () => {
  it('names the address tried for the Alemnia typo', () => {
    const result = validateRecordsResult(noMatch, 'scs:t', tried)
    expect(addressNotFoundNote(result)).toBe('Address not found at county — check spelling (tried: 9796 alemnia st, las vegas, nv)')
  })
  it('falls back to the request address for older results without address_tried', () => {
    const legacy = { ...noMatch, outcomes: [{ source: 'clark_assessor', kind: 'parcel', status: 'no_match' }] }
    expect(addressNotFoundNote(legacy)).toBe('Address not found at county — check spelling (tried: 9796 alemnia st, las vegas, nv, 89178)')
  })
  it('stays silent when a parcel matched, including a fuzzy street match', () => {
    const fixed = { line1: '9796 almenia st', city: 'las vegas', state: 'nv', postal_code: '89178' }
    const matched = { ...noMatch, address: fixed, address_version: addressVersion(fixed), status: 'complete', parcel: { id: '176-28-115-071', address: fixed, source_url: 'https://x', match_method: 'fuzzy_street', assessor_address: '9796 ALMENIA ST' }, outcomes: [{ source: 'clark_assessor', kind: 'parcel', status: 'index_only', match_method: 'fuzzy_street' }] }
    const result = validateRecordsResult(matched, 'scs:t', fixed)
    expect(result.parcel?.match_method).toBe('fuzzy_street')
    expect(result.outcomes[0].match_method).toBe('fuzzy_street')
    expect(addressNotFoundNote(result)).toBeNull()
    expect(addressNotFoundNote(null)).toBeNull()
  })
})

import { deedCheckNote, recordsJobStatusNote } from './contract'
describe('records job and deed notes on profile tiles', () => {
  it('says retrying for a transient failure and needs human check when stopped', () => {
    expect(recordsJobStatusNote({ status: 'FAILED', error: 'County records temporarily unavailable (503)' })).toBe('County records temporarily unavailable — retrying automatically')
    expect(recordsJobStatusNote({ status: 'PAUSED', error: 'Needs human check after repeated failures: County records temporarily unavailable (503)' })).toBe('Records lookup needs human check — County records temporarily unavailable (503)')
    expect(recordsJobStatusNote({ status: 'PENDING' })).toBe('County records lookup in progress')
    expect(recordsJobStatusNote({ status: 'COMPLETED' })).toBeNull()
    expect(recordsJobStatusNote(null)).toBeNull()
  })
  it('surfaces a deed that failed verification instead of a fake deed', () => {
    const detail = 'Needs human check: assessor image for 20200305:02858 failed verification (page 1 is blank or overlay-only (ink 0.20%)); no deed filed'
    expect(deedCheckNote({ outcomes: [{ kind: 'deed', status: 'failed', detail }] })).toBe(detail)
    expect(deedCheckNote({ outcomes: [{ kind: 'deed', status: 'assessor_copy', detail: '20200305:02858' }] })).toBeNull()
  })
})
