import { describe, expect, it } from 'vitest'
import { callLeadFromRow } from './from-rows'
import {
  A2P_PENDING,
  cleanText,
  dayLabel,
  displayName,
  failureReason,
  listTimeLabel,
  messagesHref,
  parseThreadKey,
  readSmsEvent,
  smsEventBody,
  threadMatches,
  withDaySeparators,
} from './messages-core'

const NOW = new Date('2026-10-12T19:00:00.000Z') // Mon Oct 12, 12:00 Pacific

describe('thread keys and links', () => {
  it('parses lead and client keys, Meta lead ids included, and refuses anything else', () => {
    expect(parseThreadKey('lead:abc123')).toEqual({ kind: 'lead', id: 'abc123' })
    expect(parseThreadKey('lead:meta:org1:9988')).toEqual({ kind: 'lead', id: 'meta:org1:9988' })
    expect(parseThreadKey(['client:c_1', 'lead:x'])).toEqual({ kind: 'client', id: 'c_1' })
    expect(parseThreadKey('number:+17025550199')).toBeNull()
    expect(parseThreadKey('lead:')).toBeNull()
    expect(parseThreadKey('lead:a b')).toBeNull()
    expect(parseThreadKey(undefined)).toBeNull()
  })

  it('keeps the base section and sets or drops extras', () => {
    expect(messagesHref('/call-center?s=messages', { t: 'lead:a' })).toBe('/call-center?s=messages&t=lead%3Aa')
    expect(messagesHref('/call-center?s=messages&t=lead:a&q=x', { t: null, q: null })).toBe('/call-center?s=messages')
    expect(messagesHref('/call-center?s=messages', { q: 'pat' })).toBe('/call-center?s=messages&q=pat')
  })
})

describe('SMS row body', () => {
  it('round-trips the text, status and sender, and has no direction in it', () => {
    const body = smsEventBody({ label: 'Text sent', detail: 'Hi Pat', userId: 'u1', status: 'sent' })
    expect(readSmsEvent(body)).toEqual({ label: 'Text sent', detail: 'Hi Pat', userId: 'u1', status: 'sent' })
    expect(body).not.toMatch(/direction/)
  })

  it('reads an old desk trail line without a status, and refuses junk', () => {
    expect(readSmsEvent(JSON.stringify({ label: 'Text', detail: 'Texted' }))).toEqual({ label: 'Text', detail: 'Texted' })
    expect(readSmsEvent('not json')).toBeNull()
    expect(readSmsEvent(JSON.stringify({ label: 'Text' }))).toBeNull()
  })

  it('a failed text is not contact on the desk; received and sent ones are', () => {
    const row = (status: string) =>
      callLeadFromRow({
        id: 'l1',
        pageId: null,
        source: 'INBOUND',
        language: 'EN',
        status: 'WAITING',
        tries: 0,
        nextAttemptAt: null,
        lockedBy: null,
        doNotCallAt: null,
        phoneLast4: '0199',
        createdAt: NOW,
        events: [{ type: 'SMS', body: smsEventBody({ label: 'Text', detail: 'hey', status: status as never }), createdAt: NOW }],
      })
    expect(row('failed').contacted).toBe(false)
    expect(row('received').contacted).toBe(true)
    expect(row('sent').contacted).toBe(true)
    expect(row('received').trail[0].detail).toBe('hey')
  })
})

describe('plain failure reasons', () => {
  it('says the owner words for A2P (30034), however the code arrives', () => {
    expect(failureReason('30034: texting registration (A2P) pending')).toBe(A2P_PENDING)
    expect(failureReason('Message from an unregistered number [code 30034]')).toBe(A2P_PENDING)
  })

  it('names other carrier codes and cleans free text', () => {
    expect(failureReason('21610: they opted out at the carrier')).toBe('Not sent: they opted out at the carrier')
    expect(failureReason('Twilio request failed: timeout')).toBe('Not sent: Twilio request failed: timeout')
    expect(failureReason('to 17025550199 refused')).toBe('Not sent: to ···· refused')
    expect(failureReason(null)).toBe('Not sent')
  })
})

describe('names, search and time', () => {
  it('falls back to the masked last 4', () => {
    expect(displayName('Pat Example', '0199')).toBe('Pat Example')
    expect(displayName('  ', '0199')).toBe('•••-•••-0199')
    expect(displayName(null, null)).toBe('Unknown number')
  })

  it('searches by name or by the last 4 digits', () => {
    const t = { name: 'Pat Example', last4: '0199' }
    expect(threadMatches(t, 'pat')).toBe(true)
    expect(threadMatches(t, '0199')).toBe(true)
    expect(threadMatches(t, '(702) 555-0199')).toBe(true)
    expect(threadMatches(t, '1234')).toBe(false)
    expect(threadMatches(t, 'nate')).toBe(false)
    expect(threadMatches(t, '')).toBe(true)
  })

  it('labels days and list times in Pacific', () => {
    expect(dayLabel(new Date('2026-10-12T16:00:00Z'), NOW)).toBe('Today')
    // 01:00 UTC on the 12th is still the 11th in Los Angeles.
    expect(dayLabel(new Date('2026-10-12T01:00:00Z'), NOW)).toBe('Yesterday')
    expect(dayLabel(new Date('2026-10-05T18:00:00Z'), NOW)).toBe('Mon, Oct 5')
    expect(dayLabel(new Date('2025-12-24T18:00:00Z'), NOW)).toBe('Wed, Dec 24, 2025')
    expect(listTimeLabel(new Date('2026-10-12T16:05:00Z'), NOW)).toBe('9:05 AM')
    expect(listTimeLabel(new Date('2026-10-09T18:00:00Z'), NOW)).toBe('Fri')
    expect(listTimeLabel(new Date('2026-10-02T18:00:00Z'), NOW)).toBe('Oct 2')
  })

  it('puts one separator before each new day', () => {
    const rows = withDaySeparators(
      [{ at: '2026-10-11T18:00:00Z' }, { at: '2026-10-11T19:00:00Z' }, { at: '2026-10-12T17:00:00Z' }],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'day' ? r.label : 'm'))).toEqual(['Yesterday', 'm', 'm', 'Today', 'm'])
  })
})

describe('composer text', () => {
  it('trims, refuses empty and caps length', () => {
    expect(cleanText('  hi \r\n there ')).toEqual({ ok: true, text: 'hi \n there' })
    expect(cleanText('   ').ok).toBe(false)
    expect(cleanText(42).ok).toBe(false)
    expect(cleanText('x'.repeat(1001)).ok).toBe(false)
  })
})
