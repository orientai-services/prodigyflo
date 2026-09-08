import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { isAgencyPassphraseConfigured, verifyAgencyPassphrase } from './passphrase'

/**
 * The passphrase is the only thing standing between an admin login and a
 * charge on the owner's card, so the closed-by-default behaviour matters as
 * much as the happy path.
 */
describe('the agency provisioning passphrase', () => {
  const original = {
    hash: process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH,
    plain: process.env.TELEPHONY_AGENCY_PASSPHRASE,
  }

  beforeEach(() => {
    delete process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH
    delete process.env.TELEPHONY_AGENCY_PASSPHRASE
  })

  afterEach(() => {
    if (original.hash) process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = original.hash
    else delete process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH
    if (original.plain) process.env.TELEPHONY_AGENCY_PASSPHRASE = original.plain
    else delete process.env.TELEPHONY_AGENCY_PASSPHRASE
  })

  it('refuses everything when nothing is configured', async () => {
    expect(isAgencyPassphraseConfigured()).toBe(false)
    const res = await verifyAgencyPassphrase('anything at all')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('NOT_CONFIGURED')
  })

  it('accepts the right passphrase against a bcrypt hash', async () => {
    process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = bcrypt.hashSync('correct horse!!', 10)
    expect(isAgencyPassphraseConfigured()).toBe(true)
    expect((await verifyAgencyPassphrase('correct horse!!')).ok).toBe(true)
  })

  it('rejects a wrong passphrase without saying why', async () => {
    process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = bcrypt.hashSync('correct horse!!', 10)
    const res = await verifyAgencyPassphrase('correct horse')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('WRONG')
    expect(res.error).not.toContain('correct horse')
  })

  it('supports a plaintext value for local development', async () => {
    process.env.TELEPHONY_AGENCY_PASSPHRASE = 'dev only'
    expect((await verifyAgencyPassphrase('dev only')).ok).toBe(true)
    expect((await verifyAgencyPassphrase('dev onl')).ok).toBe(false)
  })

  it('prefers the hash when both are set, so a stale plaintext cannot open it', async () => {
    process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = bcrypt.hashSync('the real one', 10)
    process.env.TELEPHONY_AGENCY_PASSPHRASE = 'the old one'
    expect((await verifyAgencyPassphrase('the old one')).ok).toBe(false)
    expect((await verifyAgencyPassphrase('the real one')).ok).toBe(true)
  })

  it('refuses a hash that a .env $-expansion mangled, instead of failing forever', async () => {
    // A raw bcrypt hash in a .env file loses its "$2b$10$<salt>" head to
    // Next.js's $NAME expansion, leaving only the tail. Nothing can ever match
    // it, so it must read as "not configured" rather than as a bad passphrase.
    const mangled = bcrypt.hashSync('anything', 10).replace(/^\$2[aby]?\$\d{2}\$.{22}/, '')
    process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH = mangled
    expect(isAgencyPassphraseConfigured()).toBe(false)
    const res = await verifyAgencyPassphrase('anything')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('NOT_CONFIGURED')
  })

  it('treats an empty submission as empty, not as a match', async () => {
    process.env.TELEPHONY_AGENCY_PASSPHRASE = 'dev only'
    const res = await verifyAgencyPassphrase('')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('EMPTY')
  })
})
