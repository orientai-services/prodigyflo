import { describe, expect, it } from 'vitest'
import { sameContractProperty } from './property-identity'

const before = { line1: '9796 Alemnia St', city: 'Las Vegas', state: 'NV', postalCode: '89178' }

describe('sameContractProperty', () => {
  it('keeps a Sunrun reading when only the street spelling is corrected', () => {
    expect(sameContractProperty(before, { ...before, line1: '9796 Almenia St' })).toBe(true)
  })

  it('drops contract evidence when the house number or ZIP changes', () => {
    expect(sameContractProperty(before, { ...before, line1: '9797 Almenia St' })).toBe(false)
    expect(sameContractProperty(before, { ...before, postalCode: '89117' })).toBe(false)
    expect(sameContractProperty(before, { ...before, city: 'Henderson' })).toBe(false)
  })
})
