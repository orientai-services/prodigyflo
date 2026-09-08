import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** One-way hash for values we must correlate but never read back (IPs, tokens). */
export function hashValue(value: string): string {
  const salt = process.env.AUTH_SECRET ?? 'prodigyflo'
  return createHash('sha256').update(`${salt}:${value}`).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Mask a phone to the last 4 digits: +1 (555) ***-**89 */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '••••'
  return `•••-•••-${digits.slice(-4)}`
}

/** Mask an email: jo•••@example.com */
export function maskEmail(email?: string | null): string {
  if (!email) return '—'
  const [local, domain] = email.split('@')
  if (!domain) return '••••'
  const head = local.slice(0, 2)
  return `${head}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`
}

/** Mask any government identifier down to the last 4. Never store the full value. */
export function maskIdentifier(value?: string | null): string {
  if (!value) return '—'
  const digits = value.replace(/\D/g, '')
  return digits.length >= 4 ? `•••-••-${digits.slice(-4)}` : '••••'
}

// ── Credential vault (AES-256-GCM) ───────────────────────────────────────────

export type EncryptedSecret = {
  ciphertext: string
  iv: string
  authTag: string
  keyVersion: number
}

/**
 * Derives the 32-byte vault key from the dedicated VAULT_KEY env var. This is
 * deliberately NOT AUTH_SECRET: rotating session signing must never brick the
 * credential vault, and vice versa. keyVersion is stored per row so a future
 * rotation can decrypt old rows with the old key while writing with the new.
 */
function vaultKey(keyOverride?: string): Buffer {
  const raw = keyOverride ?? process.env.VAULT_KEY
  if (!raw) {
    throw new Error('VAULT_KEY must be set to encrypt or decrypt connector credentials.')
  }
  return createHash('sha256').update(raw).digest()
}

/** Encrypt one credential value. A fresh random 12-byte IV per call — never reused. */
export function encryptSecret(plaintext: string, keyOverride?: string): EncryptedSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', vaultKey(keyOverride), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: 1,
  }
}

/**
 * Decrypt one credential value. GCM authenticates, so a tampered ciphertext,
 * IV, tag or a wrong key all throw rather than returning garbage.
 */
export function decryptSecret(secret: EncryptedSecret, keyOverride?: string): string {
  if (secret.keyVersion !== 1) {
    throw new Error(`Unknown vault key version ${secret.keyVersion}.`)
  }
  const decipher = createDecipheriv('aes-256-gcm', vaultKey(keyOverride), Buffer.from(secret.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** The only fragment of a secret ever stored readable — for masked UI rows. */
export function secretLast4(plaintext: string): string {
  return plaintext.length >= 4 ? plaintext.slice(-4) : '••••'
}
