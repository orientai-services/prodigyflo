import 'server-only'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '@/lib/crypto'
import { phoneLast4FromFields } from './meta-route'

export type ContactSecrets = {
  phoneLast4: string | null
  phoneSecret: EncryptedSecret | null
  emailSecret: EncryptedSecret | null
  /** Dialable form stored inside the secret. Not for the list. */
  dialPhone: string | null
}

/** A tel: number with digits only, optional leading +. */
export function dialablePhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 4 || digits.length > 15) return null
  if (trimmed.startsWith('+') || digits.length === 11) return `+${digits}`
  return digits
}

export function contactSecrets(fields: Record<string, string | undefined>): ContactSecrets {
  const phoneLast4 = phoneLast4FromFields(fields)
  const dialPhone = dialablePhone(fields.phone_number || fields.phone || '')
  const email = (fields.email || '').trim()
  const emailOk = /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 200
  return {
    phoneLast4,
    dialPhone,
    phoneSecret: dialPhone ? encryptSecret(dialPhone) : null,
    emailSecret: emailOk ? encryptSecret(email) : null,
  }
}

export function readSecret(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const secret = value as Partial<EncryptedSecret>
  if (typeof secret.ciphertext !== 'string' || typeof secret.iv !== 'string' || typeof secret.authTag !== 'string') {
    return null
  }
  if (secret.keyVersion !== 1) return null
  try {
    return decryptSecret({
      ciphertext: secret.ciphertext,
      iv: secret.iv,
      authTag: secret.authTag,
      keyVersion: 1,
    })
  } catch {
    return null
  }
}
