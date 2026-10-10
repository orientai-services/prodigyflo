import 'server-only'

/**
 * Optional seam to the connector credential vault.
 *
 * The vault helper `getConnectorCredentials(orgId, kind)` ships with the
 * connector-vault feature and returns the decrypted credential map for one
 * org's connector. This module feature-detects it at call time so the
 * messaging adapters work identically whether or not the vault helper exists:
 * when it is absent (or the org has stored nothing), env credentials are the
 * fallback and nothing throws.
 *
 * `inheritFromParent` walks one step up the org tree when the account itself
 * has stored nothing. An agency runs its client accounts on ONE carrier
 * account, so the credentials belong to the agency and every child should use
 * them without the operator pasting the same token three times. One step only,
 * and only as a fallback: an account that has stored its own credentials keeps
 * using them, which is what lets a client bring their own carrier.
 *
 * Never re-export vault material and never let it near a client component —
 * this file is server-only for exactly that reason.
 */
export async function vaultCredentials(
  organizationId: string | null | undefined,
  kind: 'EMAIL' | 'TWILIO_SMS',
  opts: { inheritFromParent?: boolean } = {},
): Promise<Record<string, string> | null> {
  const own = await readVault(organizationId, kind)
  if (own || !opts.inheritFromParent || !organizationId) return own

  try {
    const { db } = await import('@/lib/db')
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { parentOrganizationId: true },
    })
    return org?.parentOrganizationId ? readVault(org.parentOrganizationId, kind) : null
  } catch {
    return null
  }
}

async function readVault(
  organizationId: string | null | undefined,
  kind: 'EMAIL' | 'TWILIO_SMS',
): Promise<Record<string, string> | null> {
  if (!organizationId) return null
  try {
    const mod = (await import('@/lib/connectors/credentials')) as unknown as Record<string, unknown>
    const fn = mod.getConnectorCredentials
    if (typeof fn !== 'function') return null
    const creds = await (fn as (orgId: string, kind: string) => Promise<Record<string, string> | null>)(
      organizationId,
      kind,
    )
    return creds && Object.keys(creds).length > 0 ? creds : null
  } catch {
    // Vault unavailable or errored — the adapter falls back to env config.
    return null
  }
}

/**
 * The same read, but honest about WHY nothing came back. Telephony cannot
 * afford the silent fallback above: a vault row that exists but cannot be
 * decrypted must not quietly turn into the platform's env credentials, or an
 * org that brought its own carrier would start spending the platform's.
 *
 *   none        nothing stored for this org (or the connector is off)
 *   unreadable  stored, but it could not be decrypted (wrong VAULT_KEY, tampered)
 *   ok          decrypted; the caller still checks the fields it needs
 */
export type VaultRead =
  | { state: 'none' }
  | { state: 'unreadable'; organizationId: string }
  | { state: 'ok'; organizationId: string; creds: Record<string, string> }

async function readVaultDetailed(organizationId: string, kind: 'EMAIL' | 'TWILIO_SMS'): Promise<VaultRead> {
  let fn: ((orgId: string, kind: string) => Promise<Record<string, string> | null>) | null = null
  try {
    const mod = (await import('@/lib/connectors/credentials')) as unknown as Record<string, unknown>
    if (typeof mod.getConnectorCredentials === 'function') {
      fn = mod.getConnectorCredentials as (orgId: string, kind: string) => Promise<Record<string, string> | null>
    }
  } catch {
    return { state: 'none' }
  }
  if (!fn) return { state: 'none' }
  try {
    const creds = await fn(organizationId, kind)
    return creds && Object.keys(creds).length > 0 ? { state: 'ok', organizationId, creds } : { state: 'none' }
  } catch {
    return { state: 'unreadable', organizationId }
  }
}

/** Own vault first, then (when asked) the parent's — one step, as above. */
export async function vaultCredentialsDetailed(
  organizationId: string | null | undefined,
  kind: 'EMAIL' | 'TWILIO_SMS',
  opts: { inheritFromParent?: boolean; accept?: (creds: Record<string, string>) => boolean } = {},
): Promise<VaultRead> {
  if (!organizationId) return { state: 'none' }
  const own = await readVaultDetailed(organizationId, kind)
  const usable = (r: VaultRead) => r.state === 'unreadable' || (r.state === 'ok' && (!opts.accept || opts.accept(r.creds)))
  if (usable(own) || !opts.inheritFromParent) return usable(own) ? own : { state: 'none' }

  const { db } = await import('@/lib/db')
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { parentOrganizationId: true },
  })
  if (!org?.parentOrganizationId) return { state: 'none' }
  const parent = await readVaultDetailed(org.parentOrganizationId, kind)
  return usable(parent) ? parent : { state: 'none' }
}
