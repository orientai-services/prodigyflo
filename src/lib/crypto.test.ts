import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, secretLast4 } from '@/lib/crypto'

// Pure tests: the key is passed explicitly (keyOverride), so nothing here
// touches process.env or the database.
const KEY = 'test-vault-key'

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('sk_live_abcdef123456', KEY)
    expect(decryptSecret(enc, KEY)).toBe('sk_live_abcdef123456')
  })

  it('round-trips unicode and empty strings', () => {
    for (const value of ['', 'pässwörd — ünïcode ✓', 'a'.repeat(4096)]) {
      expect(decryptSecret(encryptSecret(value, KEY), KEY)).toBe(value)
    }
  })

  it('never reuses an IV and never emits plaintext in the envelope', () => {
    const a = encryptSecret('same-secret', KEY)
    const b = encryptSecret('same-secret', KEY)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.keyVersion).toBe(1)
    expect(JSON.stringify(a)).not.toContain('same-secret')
  })

  it('throws on a tampered ciphertext', () => {
    const enc = encryptSecret('sensitive', KEY)
    const buf = Buffer.from(enc.ciphertext, 'base64')
    buf[0] ^= 0xff
    expect(() => decryptSecret({ ...enc, ciphertext: buf.toString('base64') }, KEY)).toThrow()
  })

  it('throws on a tampered auth tag', () => {
    const enc = encryptSecret('sensitive', KEY)
    const tag = Buffer.from(enc.authTag, 'base64')
    tag[0] ^= 0xff
    expect(() => decryptSecret({ ...enc, authTag: tag.toString('base64') }, KEY)).toThrow()
  })

  it('throws when decrypting with the wrong key', () => {
    const enc = encryptSecret('sensitive', KEY)
    expect(() => decryptSecret(enc, 'a-different-key')).toThrow()
  })

  it('rejects an unknown key version instead of guessing', () => {
    const enc = encryptSecret('sensitive', KEY)
    expect(() => decryptSecret({ ...enc, keyVersion: 2 }, KEY)).toThrow(/key version/)
  })

  it('demands VAULT_KEY with a clear error when no key is available', () => {
    const prev = process.env.VAULT_KEY
    delete process.env.VAULT_KEY
    try {
      expect(() => encryptSecret('x')).toThrow(/VAULT_KEY/)
    } finally {
      if (prev !== undefined) process.env.VAULT_KEY = prev
    }
  })
})

describe('secretLast4', () => {
  it('keeps only the last four characters', () => {
    expect(secretLast4('sk_live_abcdef123456')).toBe('3456')
  })

  it('never leaks a short secret', () => {
    expect(secretLast4('abc')).toBe('••••')
  })
})
