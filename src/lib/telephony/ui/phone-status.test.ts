import { describe, expect, it } from 'vitest'
import { LOST_SERVICE, PHONE_OFF_REASON, TOKEN_ERROR_CODES, phoneIssueFrom, phoneStatus, type PhoneStatusInput } from './phone-status'

const ready: PhoneStatusInput = { mode: 'twilio', lines: 2, leader: true, registered: true, status: 'idle', issue: null }

describe('phone status pill', () => {
  it('is green and quiet when the phone is registered', () => {
    expect(phoneStatus(ready)).toEqual({ tone: 'green', label: 'Phone ready', reason: null })
  })

  it('is red with the server reason when browser calling is not set up', () => {
    expect(phoneStatus(null, "Phone calling from the browser isn't switched on yet.")).toEqual({
      tone: 'red',
      label: 'Phone off',
      reason: "Phone calling from the browser isn't switched on yet.",
    })
    expect(phoneStatus(null)).toMatchObject({ tone: 'red', reason: PHONE_OFF_REASON })
    expect(phoneStatus(null, '  ')).toMatchObject({ reason: PHONE_OFF_REASON })
  })

  it('is amber while the phone starts or reconnects by itself', () => {
    expect(phoneStatus({ ...ready, registered: false })).toMatchObject({ tone: 'amber', label: 'Connecting…' })
  })

  it('is red with the plain reason when the phone dropped and is not back', () => {
    const issue = 'Lost the connection to the phone service. It reconnects by itself when the internet is back.'
    expect(phoneStatus({ ...ready, registered: false, issue })).toEqual({ tone: 'red', label: 'Phone off', reason: issue })
  })

  it('goes back to green once the phone registers again, whatever the last issue was', () => {
    expect(phoneStatus({ ...ready, issue: 'stale' })).toMatchObject({ tone: 'green', label: 'Phone ready' })
  })

  it('is red when there is no line to call from', () => {
    expect(phoneStatus({ ...ready, lines: 0 })).toMatchObject({ tone: 'red', label: 'Phone off' })
    // A dropped phone is named first; it is what is wrong right now.
    expect(phoneStatus({ ...ready, lines: 0, registered: false, issue: LOST_SERVICE }).reason).toBe(LOST_SERVICE)
  })

  it('shows the call in progress', () => {
    expect(phoneStatus({ ...ready, status: 'in-call' })).toMatchObject({ tone: 'green', label: 'On a call' })
    expect(phoneStatus({ ...ready, status: 'connecting' })).toMatchObject({ tone: 'green', label: 'Calling…' })
    expect(phoneStatus({ ...ready, registered: false, status: 'ringing' })).toMatchObject({ tone: 'green' })
  })

  it('is green in a tab that is not the ringing one', () => {
    expect(phoneStatus({ ...ready, leader: false, registered: false })).toMatchObject({
      tone: 'green',
      reason: 'Calls ring in your other tab of this app.',
    })
  })

  it('says test mode out loud', () => {
    expect(phoneStatus({ ...ready, mode: 'mock' }).reason).toBe('Test mode. No real calls are placed.')
  })
})

describe('phone issues from the SDK', () => {
  it('treats a dropped signalling socket as a reconnecting service, not a call error', () => {
    for (const code of [31000, 31003, 31005, 31009, 53000, 53405]) {
      expect(phoneIssueFrom({ code })).toBe(LOST_SERVICE)
    }
  })

  it('names the session and the microphone in plain words', () => {
    expect(phoneIssueFrom({ code: 31205 })).toBe('Your phone session expired. Reload the page.')
    expect(phoneIssueFrom({ name: 'NotAllowedError' })).toBe('Allow the microphone to make and take calls.')
    expect([...TOKEN_ERROR_CODES].sort()).toEqual([20101, 20104, 31204, 31205])
  })

  it('keeps the code of anything else', () => {
    expect(phoneIssueFrom({ code: 31100 })).toBe('The phone stopped working (code 31100). Reload the page.')
    expect(phoneIssueFrom(null)).toBe('The phone stopped working. Reload the page.')
  })
})
