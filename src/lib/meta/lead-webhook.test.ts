import { describe, expect, it } from 'vitest'
import { credentialsConfigured } from './provider'
import { firstTouch } from './ignition'

describe('credentialsConfigured (Meta lead webhook gating)', () => {
  it('is configured with app id + secret + a Page token', () => {
    expect(credentialsConfigured({ appId: 'a', appSecret: 's', pageAccessToken: 'p' })).toBe(true)
  })

  it('is configured with app id + secret + a System User token (no Page token)', () => {
    // The whole point of the fix: a single system-user token can run the webhook.
    expect(credentialsConfigured({ appId: 'a', appSecret: 's', systemUserToken: 'su' })).toBe(true)
  })

  it('is NOT configured without any lead-reading token', () => {
    expect(credentialsConfigured({ appId: 'a', appSecret: 's' })).toBe(false)
  })

  it('is NOT configured without an app secret (signature check would be impossible)', () => {
    expect(credentialsConfigured({ appId: 'a', systemUserToken: 'su' })).toBe(false)
  })

  it('is NOT configured on empty credentials', () => {
    expect(credentialsConfigured({})).toBe(false)
  })
})

describe('firstTouch (Instant Lead Ignition draft)', () => {
  it('personalises with the first name and campaign in both languages', () => {
    const d = firstTouch('Maria', 'Q3 Relief Awareness')
    expect(d.en).toContain('Hi Maria')
    expect(d.en).toContain('Q3 Relief Awareness')
    expect(d.es).toContain('Hola Maria')
    expect(d.es).toContain('sobre Q3 Relief Awareness')
  })

  it('degrades gracefully when the name is blank', () => {
    const d = firstTouch('', null)
    expect(d.en).toContain('Hi there')
    expect(d.es).toContain('Hola buenas')
    // No campaign clause when there is no campaign.
    expect(d.en).not.toContain('about ')
    expect(d.es).not.toContain('sobre ')
  })

  it('always produces non-empty copy in both languages', () => {
    const d = firstTouch('Devon', null)
    expect(d.en.length).toBeGreaterThan(20)
    expect(d.es.length).toBeGreaterThan(20)
  })
})
