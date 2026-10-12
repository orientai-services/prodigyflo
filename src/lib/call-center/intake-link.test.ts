import { describe, expect, it } from 'vitest'
import {
  INTAKE_LINK_TTL_MS,
  intakeTextBlock,
  intakeTextBody,
  intakeTokenId,
  scsIntakeUrl,
  signIntakeToken,
  verifyIntakeToken,
} from './intake-link'

const SECRET = 'test-only-auth-secret-for-intake-links'
const NOW = new Date('2026-10-12T18:00:00.000Z') // 11:00 in Las Vegas

describe('intake link token', () => {
  it('round-trips a cuid and a meta lead id', () => {
    for (const id of ['cmtx2mtf7000004lb2so1n1qe', 'meta:org1:123456789']) {
      const token = signIntakeToken(id, NOW, SECRET)
      const check = verifyIntakeToken(token, NOW, SECRET)
      expect(check).toMatchObject({ ok: true, leadId: id, tokenId: intakeTokenId(token) })
      if (check.ok) expect(check.expiresAt.getTime()).toBe(Math.floor((NOW.getTime() + INTAKE_LINK_TTL_MS) / 1000) * 1000)
    }
  })

  it('expires after 14 days', () => {
    const token = signIntakeToken('lead1', NOW, SECRET)
    expect(verifyIntakeToken(token, new Date(NOW.getTime() + INTAKE_LINK_TTL_MS - 60_000), SECRET).ok).toBe(true)
    expect(verifyIntakeToken(token, new Date(NOW.getTime() + INTAKE_LINK_TTL_MS + 1000), SECRET)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects tampering, another key, and junk', () => {
    const token = signIntakeToken('lead1', NOW, SECRET)
    const [v, id, exp, sig] = token.split('.')
    const otherLead = `${v}.${Buffer.from('lead2').toString('base64url')}.${exp}.${sig}`
    const later = `${v}.${id}.${Number(exp) + 86_400}.${sig}`
    expect(verifyIntakeToken(otherLead, NOW, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyIntakeToken(later, NOW, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyIntakeToken(token, NOW, 'another-secret')).toEqual({ ok: false, reason: 'bad_signature' })
    expect(verifyIntakeToken(`${token}x`, NOW, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    for (const junk of ['', 'v1.a.b', 'v2.a.1.b', 42, null, 'x'.repeat(700)]) {
      expect(verifyIntakeToken(junk, NOW, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    }
    expect(verifyIntakeToken(token, NOW, '')).toEqual({ ok: false, reason: 'no_secret' })
  })

  it('refuses to sign without a secret or for a non-desk id', () => {
    expect(() => signIntakeToken('lead1', NOW, '')).toThrow()
    expect(() => signIntakeToken('bad id/../', NOW, SECRET)).toThrow()
  })
})

describe('intake link url', () => {
  it('carries the token, attribution and fresh=1, and no PII', () => {
    const token = signIntakeToken('lead1', NOW, SECRET)
    const url = new URL(scsIntakeUrl({ token, pageId: '1376160392241486', leadAttribution: { adId: 'ad-77', formId: 'f-1' } }))
    expect(url.origin + url.pathname).toBe('https://solarcontractservices.com/begin')
    expect(url.searchParams.get('pfl')).toBe(token)
    expect(url.searchParams.get('utm_source')).toBe('prodigyflo')
    expect(url.searchParams.get('utm_medium')).toBe('call_center')
    expect(url.searchParams.get('utm_campaign')).toBe('1376160392241486')
    expect(url.searchParams.get('utm_content')).toBe('ad-77')
    expect(url.searchParams.get('fresh')).toBe('1')
    expect(url.searchParams.has('assist')).toBe(false)
    expect([...url.searchParams.keys()].sort()).toEqual(['fresh', 'pfl', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source'])
  })

  it('marks the rep-assisted path and falls back to the form id', () => {
    const url = new URL(scsIntakeUrl({ token: 't', leadAttribution: { formId: 'f-1' }, assist: true }))
    expect(url.searchParams.get('assist')).toBe('1')
    expect(url.searchParams.get('utm_content')).toBe('f-1')
    expect(url.searchParams.has('utm_campaign')).toBe(false)
  })
})

describe('text link gate', () => {
  const ok = { consentAt: new Date('2026-10-01'), consentRevokedAt: null, doNotCallAt: null, timeZone: 'America/Los_Angeles' }

  it('allows a consented lead in hours with live SMS', () => {
    expect(intakeTextBlock(ok, false, NOW)).toBeNull()
  })

  it('refuses mock SMS, no consent, STOP, do-not-call and out of hours', () => {
    expect(intakeTextBlock(ok, true, NOW)).toMatch(/not switched on/)
    expect(intakeTextBlock({ ...ok, consentAt: null }, false, NOW)).toMatch(/No consent/)
    expect(intakeTextBlock({ ...ok, consentRevokedAt: NOW }, false, NOW)).toMatch(/STOP/)
    expect(intakeTextBlock({ ...ok, doNotCallAt: NOW }, false, NOW)).toMatch(/do-not-call/)
    // 06:00 and 20:30 in Las Vegas.
    expect(intakeTextBlock(ok, false, new Date('2026-10-12T13:00:00.000Z'))).toMatch(/Outside texting hours/)
    expect(intakeTextBlock(ok, false, new Date('2026-10-13T03:30:00.000Z'))).toMatch(/Outside texting hours/)
    // The lead's own zone decides: 11:00 Pacific is 14:00 in New York, 08:00 in Honolulu.
    expect(intakeTextBlock({ ...ok, timeZone: 'Pacific/Honolulu' }, false, NOW)).toMatch(/Outside texting hours/)
  })

  it('writes the text in the lead language with opt-out words', () => {
    expect(intakeTextBody('https://x', 'EN')).toMatch(/https:\/\/x .*STOP/)
    expect(intakeTextBody('https://x', 'ES')).toMatch(/enlace.*STOP/)
  })
})
