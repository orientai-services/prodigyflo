import { describe, expect, it } from 'vitest'
import { carrierCodeFrom, explainCarrierError, failureCodeText, smsStatusLabel } from './carrier-errors'

describe('carrier error meanings', () => {
  const listed: [string, string, boolean][] = [
    ['30034', 'texting registration (A2P) pending', true],
    ['21408', "texting to that country isn't enabled", true],
    ['21610', 'they opted out at the carrier', true],
    ['21211', 'not a valid number', true],
    ['21614', 'not a mobile number', true],
    ['30003', 'phone unreachable', false],
    ['30005', 'unknown number', false],
    ['30006', "landline or carrier can't take texts", false],
    ['30007', 'carrier filtered it', false],
    ['30008', 'carrier error, unknown', false],
    ['10004', 'account allows one call at a time', true],
    ['13227', 'no permission to call that country', true],
  ]

  it.each(listed)('%s means "%s"', (code, meaning, blocked) => {
    const info = explainCarrierError(code)
    expect(info.meaning).toBe(meaning)
    expect(info.blocked).toBe(blocked)
    expect(info.docsUrl).toBe(`https://www.twilio.com/docs/api/errors/${code}`)
  })

  it('never invents a meaning for an unlisted code', () => {
    expect(explainCarrierError('99999')).toMatchObject({ meaning: 'Carrier error 99999', blocked: false })
    expect(explainCarrierError(null).meaning).toBe('Carrier error')
  })

  it('reads the code out of the stored failure text', () => {
    expect(carrierCodeFrom('30034: texting registration (A2P) pending')).toBe('30034')
    expect(carrierCodeFrom("The 'To' number is not valid. [code 21211]")).toBe('21211')
    expect(carrierCodeFrom('Twilio request failed: timeout')).toBeNull()
    expect(failureCodeText('30034')).toBe('30034: texting registration (A2P) pending')
    expect(failureCodeText('12345')).toBe('12345: Carrier error 12345')
  })
})

describe('what an SMS row says', () => {
  it('SENT is only "Accepted by carrier"; DELIVERED needs the callback', () => {
    expect(smsStatusLabel('SENT', null)).toBe('Accepted by carrier')
    expect(smsStatusLabel('DELIVERED', null)).toBe('Delivered')
    expect(smsStatusLabel('READ', null)).toBe('Delivered')
    expect(smsStatusLabel('QUEUED', null)).toBe('Sending')
    expect(smsStatusLabel('RECEIVED', null)).toBe('Received')
  })

  it('a blocked code reads "Blocked: …", any other failure "Failed: …"', () => {
    expect(smsStatusLabel('FAILED', '30034: texting registration (A2P) pending')).toBe('Blocked: texting registration (A2P) pending')
    expect(smsStatusLabel('FAILED', '30003: phone unreachable')).toBe('Failed: phone unreachable')
    expect(smsStatusLabel('FAILED', "Invalid number [code 21211]")).toBe('Blocked: not a valid number')
    expect(smsStatusLabel('FAILED', 'Twilio request failed: timeout')).toBe('Failed: Twilio request failed: timeout')
    expect(smsStatusLabel('FAILED', null)).toBe('Failed')
  })
})
