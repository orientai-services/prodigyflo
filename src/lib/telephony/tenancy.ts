import 'server-only'
import { can, type SessionUser } from '@/lib/rbac'
import { isPlatformAccount, platformCredentials, telephonyCredentialsDetailed, type DetailedCredentials } from './index'
import type { TelephonyCredentials } from './provider'

/**
 * Who may see and change what on a SHARED carrier account.
 *
 * The "ProdigyFlo Platform" Twilio subaccount (TWILIO_* env) serves several
 * organizations at once. Anything account-wide — the number list, the balance,
 * carrier errors, the voice-limit switch, Messaging Services — belongs to the
 * platform owner only: a SUPER_ADMIN whose home organization is
 * TELEPHONY_PLATFORM_ORG_ID. A per-org SUPER_ADMIN of any other organization
 * is NOT a platform owner, and when the variable is unset nobody is.
 *
 * An org that brought its own Twilio (vault credentials) manages its own
 * account through its own telephony:manage holders. A vault entry carrying
 * the platform's Account SID is never "its own" account (see
 * telephonyCredentialsDetailed): it is treated as the platform account here.
 */

export const PLATFORM_OWNER_MISSING = "Platform owner isn't configured."
export const PLATFORM_ONLY = 'Number sync for the shared account is done by the platform owner.'

export function platformOrgId(): string | null {
  return process.env.TELEPHONY_PLATFORM_ORG_ID?.trim() || null
}

export function isPlatformOwner(user: Pick<SessionUser, 'role' | 'organizationId' | 'homeOrganizationId'>): boolean {
  const platform = platformOrgId()
  if (!platform) return false
  if (user.role !== 'SUPER_ADMIN') return false
  return (user.homeOrganizationId ?? user.organizationId) === platform
}

export type CredentialScope =
  | { kind: 'platform'; creds: TelephonyCredentials }
  | { kind: 'vault'; creds: TelephonyCredentials; vaultOrgId: string }
  | { kind: 'none'; reason: 'unreadable' | 'none' }

export function scopeFrom(detailed: DetailedCredentials): CredentialScope {
  if (!detailed.creds) return { kind: 'none', reason: detailed.reason }
  if (detailed.source === 'vault' && !isPlatformAccount(detailed.creds)) {
    return { kind: 'vault', creds: detailed.creds, vaultOrgId: detailed.vaultOrgId }
  }
  // Never a vault token next to the platform SID: the platform's own env pair.
  const platform = detailed.source === 'platform' ? detailed.creds : platformCredentials()
  return platform ? { kind: 'platform', creds: platform } : { kind: 'none', reason: 'unreadable' }
}

/** Which carrier account an org rides, and whose it is. */
export async function credentialScope(organizationId: string): Promise<CredentialScope> {
  return scopeFrom(await telephonyCredentialsDetailed(organizationId))
}

export type AccountGuard = { ok: true; scope: Exclude<CredentialScope, { kind: 'none' }> } | { ok: false; error: string; code: string }

/**
 * May `user` act on the CARRIER ACCOUNT behind `organizationId` (sync numbers,
 * set the voice-limit mode, record carrier state, set Messaging Services)?
 *
 *   platform account → the platform owner only
 *   own vault account → telephony:manage in the org whose vault holds it
 */
export async function guardAccountAction(user: SessionUser, organizationId: string): Promise<AccountGuard> {
  const scope = await credentialScope(organizationId)
  if (scope.kind === 'none') {
    return {
      ok: false,
      code: scope.reason === 'unreadable' ? 'CREDENTIALS_UNREADABLE' : 'NOT_CONFIGURED',
      error:
        scope.reason === 'unreadable'
          ? "This account's stored Twilio credentials can't be read. Re-enter them under Settings → Connectors."
          : "Phone calling isn't set up yet.",
    }
  }
  if (scope.kind === 'platform') {
    if (!platformOrgId()) return { ok: false, code: 'NO_PLATFORM_OWNER', error: PLATFORM_OWNER_MISSING }
    if (!isPlatformOwner(user)) return { ok: false, code: 'PLATFORM_ONLY', error: PLATFORM_ONLY }
    return { ok: true, scope }
  }
  if (!can(user, 'telephony:manage') || user.organizationId !== scope.vaultOrgId) {
    return { ok: false, code: 'FORBIDDEN', error: "You can't change this account's carrier settings." }
  }
  return { ok: true, scope }
}
