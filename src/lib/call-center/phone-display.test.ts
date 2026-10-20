import { describe, expect, it } from 'vitest'
import {
  NUMBER_UNAVAILABLE,
  formatLeadPhone,
  leadPhoneView,
  maskedLast4,
  maySeeLeadPhone,
  phoneE164,
  phoneText,
} from './phone-display'

// docs/DIALER_APP.md §Phone numbers: who sees a full number and how it reads.
describe('lead phone display', () => {
  it('formats US numbers as (702) 555-0123 from every stored shape', () => {
    for (const raw of ['+17025550123', '17025550123', '7025550123', ' (702) 555-0123 ']) {
      expect(formatLeadPhone(raw)).toEqual({ display: '(702) 555-0123', copy: '+17025550123' })
    }
  })

  it('keeps another country as +<digits>', () => {
    expect(formatLeadPhone('+573001234567')).toEqual({ display: '+573001234567', copy: '+573001234567' })
    expect(formatLeadPhone('+447700900123')?.display).toBe('+447700900123')
  })

  it('refuses what is not a phone number', () => {
    for (const raw of [null, undefined, '', '12', '+12', 'abc', '+1234567890123456']) expect(formatLeadPhone(raw)).toBeNull()
    expect(phoneE164('555-0123')).toBeNull()
  })

  it('shows numbers for every authenticated role on visible records, including do-not-call', () => {
    const admin = { id: 'u-admin', role: 'SUPER_ADMIN' }
    const rep = { id: 'u-rep', role: 'CLOSER' }
    const held = { lockedBy: 'u-rep', doNotCallAt: null }
    const other = { lockedBy: 'u-other', doNotCallAt: null }
    const open = { lockedBy: null, doNotCallAt: null }
    const dnc = { lockedBy: 'u-rep', doNotCallAt: new Date() }
    expect(maySeeLeadPhone(admin, other)).toBe(true)
    expect(maySeeLeadPhone(admin, dnc)).toBe(true)
    expect(maySeeLeadPhone(rep, held)).toBe(true)
    expect(maySeeLeadPhone(rep, other)).toBe(true)
    expect(maySeeLeadPhone(rep, open)).toBe(true)
    expect(maySeeLeadPhone(rep, dnc)).toBe(true)
    // An empty viewer id never matches an unlocked lead.
    expect(maySeeLeadPhone({ id: '', role: 'CLOSER' }, open)).toBe(false)
  })

  it('reads "Number unavailable" when the number exists but will not decrypt, and nothing when there is none', () => {
    expect(leadPhoneView('+17025550123', true)).toEqual({ state: 'shown', display: '(702) 555-0123', copy: '+17025550123' })
    expect(leadPhoneView(null, true)).toEqual({ state: 'unavailable' })
    expect(leadPhoneView('garbage', true)).toEqual({ state: 'unavailable' })
    expect(leadPhoneView(null, false)).toBeNull()
  })

  it('falls back to the last four for everyone else', () => {
    expect(maskedLast4('0123')).toBe('•••-•••-0123')
    expect(maskedLast4(null)).toBe('—')
    expect(phoneText(undefined, '0123')).toBe('•••-•••-0123')
    expect(phoneText({ state: 'unavailable' }, '0123')).toBe(NUMBER_UNAVAILABLE)
    expect(phoneText({ state: 'shown', display: '(702) 555-0123', copy: '+17025550123' }, '0123')).toBe('(702) 555-0123')
  })
})
