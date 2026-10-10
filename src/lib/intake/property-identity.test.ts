import { describe, expect, it } from 'vitest'
import { profileAddressAfterPacket, sameContractClient, sameContractProperty } from './property-identity'

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

describe('later SCS packets', () => {
  const corrected = { line1: '9796 Almenia St', city: 'Las Vegas', state: 'NV', postalCode: '89178' }
  const typo = { ...corrected, line1: '9796 Alemnia St' }

  it('keeps the corrected street when intake repeats the typo', () => {
    expect(profileAddressAfterPacket(corrected, typo)).toEqual({ address: corrected, sameHouse: true })
  })

  it('stores the first address and replaces a different house', () => {
    expect(profileAddressAfterPacket(null, typo)).toEqual({ address: typo, sameHouse: false })
    expect(profileAddressAfterPacket(corrected, { ...corrected, line1: '9797 Almenia St' }).sameHouse).toBe(false)
  })

  it('treats the same person at the corrected street as the same client', () => {
    const person = { firstName: 'Daryl', lastName: 'Schelin', ...corrected }
    expect(sameContractClient({ ...person, line1: '9796 Alemnia St' }, person)).toBe(true)
    expect(sameContractClient({ ...person, lastName: 'Other' }, person)).toBe(false)
  })
})
