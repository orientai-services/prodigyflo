import { describe, expect, it } from 'vitest'
import { caseChannelFor, chatHref, parseChatHash, parseChatUrl, titleWithCount } from './host-bus'
import { pushSupport, vapidKeyBytes } from './push'

/** The Team chat ↔ shell seam (docs/TEAM_CHAT_PARITY.md A2, A4, A5, F2): deep links, the title prefix, push support. */

describe('chat deep links', () => {
  it('reads #c=, #m=, #thread= and #case=', () => {
    expect(parseChatHash('#c=c_0123456789abcde')).toEqual({ channel: 'c_0123456789abcde', message: null, thread: null, lead: null })
    expect(parseChatHash('#c=c_1&m=m_2&thread=m_3')).toEqual({ channel: 'c_1', message: 'm_2', thread: 'm_3', lead: null })
    expect(parseChatHash('#case=meta%3Aorg1%3A123')).toEqual({ channel: null, message: null, thread: null, lead: 'meta:org1:123' })
    expect(parseChatHash('#m=m_2')).toBeNull()
    expect(parseChatHash('#c=<script>')).toBeNull()
    expect(parseChatHash('')).toBeNull()
    expect(parseChatHash('#case=%E0%A4%A')).toBeNull()
  })

  it('only follows our own Call Center URLs', () => {
    const o = 'https://www.prodigyflo.ai'
    expect(parseChatUrl(`${o}/call-center?s=messages#c=c_1&thread=m_9`, o)).toMatchObject({ channel: 'c_1', thread: 'm_9' })
    expect(parseChatUrl('https://evil.example/call-center#c=c_1', o)).toBeNull()
    expect(parseChatUrl(`${o}/clients#c=c_1`, o)).toBeNull()
  })

  it('builds Messages links, the case link by lead id', () => {
    expect(chatHref({ channel: 'c_1', message: 'm_2' })).toBe('/call-center?s=messages#c=c_1&m=m_2')
    expect(chatHref({ lead: 'meta:org1:123' })).toBe('/call-center?s=messages#case=meta%3Aorg1%3A123')
    expect(parseChatHash(chatHref({ lead: 'meta:org1:123' }).split('#')[1])?.lead).toBe('meta:org1:123')
    expect(chatHref({})).toBe('/call-center?s=messages')
  })

  it('finds a PF lead’s case channel by pf:<lead id>', () => {
    const list = [
      { id: 'c_a', case: { lead_id: 'pf:meta:o:1' } },
      { id: 'c_b', case: { lead_id: 'L123' } },
      { id: 'c_c', case: null },
    ]
    expect(caseChannelFor(list, 'meta:o:1')?.id).toBe('c_a')
    expect(caseChannelFor(list, 'L123')).toBeNull()
  })
})

describe('title prefix', () => {
  it('adds, replaces and drops "(n) "', () => {
    expect(titleWithCount('Call Center', 3)).toBe('(3) Call Center')
    expect(titleWithCount('(3) Call Center', 120)).toBe('(99+) Call Center')
    expect(titleWithCount('(99+) Call Center', 0)).toBe('Call Center')
  })
})

describe('push support', () => {
  const base = { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', standalone: false, hasSw: true, hasPush: true, hasNotification: true }
  it('asks iPhone users to install first, and says when a browser cannot', () => {
    expect(pushSupport(base)).toBe('ok')
    expect(pushSupport({ ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', hasPush: false, hasNotification: false })).toBe('ios_install')
    expect(pushSupport({ ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', standalone: true })).toBe('ok')
    expect(pushSupport({ ...base, hasPush: false })).toBe('unsupported')
  })
  it('decodes a base64url VAPID key', () => {
    expect(Array.from(vapidKeyBytes('AQID_-8'))).toEqual([1, 2, 3, 255, 239])
  })
})
