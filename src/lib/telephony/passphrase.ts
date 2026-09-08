import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '@/lib/crypto'
import { mergeOrgSettings } from '@/lib/org-settings'

/**
 * The agency provisioning passphrase.
 *
 * Internal accounts (ProdigyFlo, CYS, SCS) buy numbers on the agency's card
 * instead of a prepaid balance, so the money gate that protects every other
 * account does not apply to them. This passphrase replaces it: a shared secret
 * the owner holds, entered per purchase, on top of the ordinary
 * telephony:manage permission. An admin login alone can never spend the card.
 *
 * There are two places it can live, and the app is the better one:
 *
 *  1. SET IN THE APP (preferred) — the owner sets it on the phone-numbers
 *     console. What is stored on the organization is a bcrypt hash, and that
 *     hash is itself AES-256-GCM encrypted with VAULT_KEY, so a database dump
 *     alone yields nothing to attack. This is checked first, needs no shell on
 *     the server, and can be rotated from a browser.
 *
 *  2. AN ENVIRONMENT VARIABLE (fallback) — how a fresh install bootstraps
 *     before anyone can sign in. Configure it as a bcrypt hash so the
 *     plaintext lives nowhere on the server:
 *
 *   node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'the passphrase'
 *
 * ⚠ A bcrypt hash is full of `$`, and Next.js expands `$NAME` when it loads a
 * .env file — pasted raw, the `$2b$10$<salt>` head is silently eaten and the
 * passphrase can then never be right. In a .env file, escape every dollar:
 *
 *   TELEPHONY_AGENCY_PASSPHRASE_HASH='\$2b\$10\$<the rest of the hash>'
 *
 * (systemd EnvironmentFiles, like /etc/prodigyflo.env, do NOT expand — paste
 * the hash there unescaped.) isAgencyPassphraseConfigured() shape-checks the
 * value precisely so this mistake surfaces as "not configured" rather than as
 * a passphrase that is mysteriously always wrong.
 *
 * TELEPHONY_AGENCY_PASSPHRASE (plaintext) is accepted as a last fallback for
 * local development only, and is compared in constant time.
 *
 * With NONE of them set, verification always fails — closed by default. An
 * internal account then simply cannot buy a number until the owner configures
 * the passphrase, which is the correct failure mode for something that spends
 * money.
 */

/** Where `settings.telephony.provisioningPassphrase` lives on the org row. */
const SETTINGS_KEY = 'telephony'
const SETTINGS_FIELD = 'provisioningPassphrase'

export type PassphraseCheck =
  | { ok: true }
  | { ok: false; code: 'NOT_CONFIGURED' | 'EMPTY' | 'WRONG'; error: string }

const NOT_CONFIGURED: PassphraseCheck = {
  ok: false,
  code: 'NOT_CONFIGURED',
  error:
    'No agency provisioning passphrase is configured on this server, so numbers cannot be charged to the agency card. Set TELEPHONY_AGENCY_PASSPHRASE_HASH and restart.',
}

/** A well-formed bcrypt hash — the shape check that catches a mangled `$`. */
const BCRYPT_SHAPE = /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/

function configuredHash(): string | null {
  const raw = process.env.TELEPHONY_AGENCY_PASSPHRASE_HASH?.trim()
  if (!raw) return null
  return BCRYPT_SHAPE.test(raw) ? raw : null
}

/** True when the server can check a passphrase at all — the console shows why not. */
export function isAgencyPassphraseConfigured(): boolean {
  return Boolean(configuredHash() || process.env.TELEPHONY_AGENCY_PASSPHRASE?.trim())
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// ── Stored on the organization (the preferred source) ───────────────────────

/** Shape of the encrypted blob under settings.telephony.provisioningPassphrase. */
function readStoredBlob(settings: unknown): EncryptedSecret | null {
  const telephony = (settings as Record<string, unknown> | null)?.[SETTINGS_KEY]
  const blob = (telephony as Record<string, unknown> | undefined)?.[SETTINGS_FIELD]
  if (!blob || typeof blob !== 'object') return null
  const candidate = blob as Record<string, unknown>
  if (
    typeof candidate.ciphertext !== 'string' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.authTag !== 'string' ||
    typeof candidate.keyVersion !== 'number'
  ) {
    return null
  }
  return candidate as unknown as EncryptedSecret
}

/**
 * The bcrypt hash this organization has stored, decrypted. Returns null when
 * nothing is stored; a stored blob that will not decrypt (wrong or rotated
 * VAULT_KEY, tampering) also returns null rather than throwing, so a broken
 * blob degrades to the env fallback and then to "not configured" instead of
 *500-ing the whole console.
 */
async function storedHash(organizationId: string): Promise<string | null> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  })
  const blob = readStoredBlob(org?.settings)
  if (!blob) return null
  try {
    const hash = decryptSecret(blob)
    return BCRYPT_SHAPE.test(hash) ? hash : null
  } catch {
    return null
  }
}

export type PassphraseSource = 'app' | 'env' | null

export type PassphraseStatus = {
  configured: boolean
  /** 'app' = set by the owner in the console; 'env' = a server env var. */
  source: PassphraseSource
}

/**
 * What the console shows. Deliberately reports only WHETHER a passphrase
 * exists and where it came from — never any part of it.
 */
export async function agencyPassphraseStatus(organizationId?: string): Promise<PassphraseStatus> {
  if (organizationId && (await storedHash(organizationId))) return { configured: true, source: 'app' }
  if (isAgencyPassphraseConfigured()) return { configured: true, source: 'env' }
  return { configured: false, source: null }
}

/**
 * Stores a new passphrase for the organization. The caller is responsible for
 * the permission and step-up checks — this only does the cryptography.
 *
 * Never logs, returns, or audits the passphrase itself. Storing replaces
 * whatever was there; the previous value is unrecoverable, which is the point.
 */
export const MIN_PASSPHRASE_LENGTH = 8

export async function setAgencyPassphrase(
  organizationId: string,
  passphrase: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const value = passphrase.trim()
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` }
  }
  const encrypted = encryptSecret(await bcrypt.hash(value, 10))
  await mergeOrgSettings(organizationId, SETTINGS_KEY, {
    [SETTINGS_FIELD]: encrypted as unknown as Record<string, unknown>,
  })
  return { ok: true }
}

/** Removes the stored passphrase. Any env fallback then applies again. */
export async function clearAgencyPassphrase(organizationId: string): Promise<void> {
  await mergeOrgSettings(organizationId, SETTINGS_KEY, { [SETTINGS_FIELD]: null })
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * Verifies a submitted passphrase against the organization's stored value
 * first, then the env fallbacks. Never reveals which source matched, and never
 * echoes any part of the value back to the caller.
 */
export async function verifyAgencyPassphrase(
  submitted: string,
  opts: { organizationId?: string } = {},
): Promise<PassphraseCheck> {
  if (!submitted) return { ok: false, code: 'EMPTY', error: 'Enter the agency provisioning passphrase.' }

  const stored = opts.organizationId ? await storedHash(opts.organizationId) : null
  if (stored) {
    const ok = await bcrypt.compare(submitted, stored)
    return ok ? { ok: true } : { ok: false, code: 'WRONG', error: 'That passphrase is not correct.' }
  }

  const hash = configuredHash()
  if (hash) {
    const ok = await bcrypt.compare(submitted, hash)
    return ok ? { ok: true } : { ok: false, code: 'WRONG', error: 'That passphrase is not correct.' }
  }

  const plain = process.env.TELEPHONY_AGENCY_PASSPHRASE?.trim()
  if (plain) {
    return constantTimeEquals(submitted, plain)
      ? { ok: true }
      : { ok: false, code: 'WRONG', error: 'That passphrase is not correct.' }
  }

  return NOT_CONFIGURED
}
