import 'server-only'
import { adsBinding, adsMockAllowed, mockAdAccountId } from './allowlist'

/**
 * Which mode a workspace's ads reporting is in, and with which credentials
 * (docs/META_ADS_SCS.md decisions 1, 4 and 9).
 *
 *  - live: the workspace is the bound one AND one complete ads credential set
 *    exists, taken whole from ONE source: the vault when any ads field is there,
 *    else env. Never mixed field by field. Never the lead-intake fields.
 *  - mock: only where adsMockAllowed() (dev, test, preview), for the bound
 *    workspace without credentials, or for any workspace when nothing is bound.
 *  - not_connected: everything else. Production with no credentials lands here.
 */

export type AdsMode = 'live' | 'mock' | 'not_connected'

export type AdsCreds = { token: string; appId: string; appSecret?: string }

export type AdsConfig = {
  mode: AdsMode
  creds?: AdsCreds
  /** live: the allowlisted accounts; mock: the workspace's mock id; else []. */
  accounts: string[]
  /** First account, for single-account callers. */
  adAccountId?: string
  reason?: string
}

export const ADS_FIELD_KEYS = ['adsAppId', 'adsAppSecret', 'adsSystemUserToken'] as const

type Env = Record<string, string | undefined>

export const NOT_CONNECTED_HERE = "Meta Ads reporting isn't connected for this workspace."
export const INCOMPLETE = 'Ads credentials are incomplete.'
export const MISSING = "Ads credentials aren't set."

async function vaultAdsFields(orgId: string): Promise<Record<string, string> | null> {
  try {
    const mod = await import('@/lib/connectors/credentials')
    const vault = await mod.getConnectorCredentials(orgId, 'META_ADS')
    if (!vault) return null
    const out: Record<string, string> = {}
    for (const k of ADS_FIELD_KEYS) if (vault[k]) out[k] = vault[k]
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

/** One whole set from one source; null + reason otherwise. Exported for tests. */
export function pickAdsCreds(
  vault: Record<string, string> | null,
  env: Env,
): { creds: AdsCreds | null; source: 'vault' | 'env' | 'none'; reason?: string } {
  if (vault && Object.keys(vault).length > 0) {
    const token = vault.adsSystemUserToken, appId = vault.adsAppId, appSecret = vault.adsAppSecret
    if (!token || !appId || !appSecret) return { creds: null, source: 'vault', reason: INCOMPLETE }
    return { creds: { token, appId, appSecret }, source: 'vault' }
  }
  const token = env.META_ADS_SYSTEM_USER_TOKEN?.trim(), appId = env.META_ADS_APP_ID?.trim(), appSecret = env.META_ADS_APP_SECRET?.trim()
  if (!token && !appId && !appSecret) return { creds: null, source: 'none', reason: MISSING }
  if (!token || !appId || !appSecret) return { creds: null, source: 'env', reason: INCOMPLETE }
  return { creds: { token, appId, appSecret }, source: 'env' }
}

export async function resolveAdsConfig(orgId: string, env: Env = process.env): Promise<AdsConfig> {
  const binding = adsBinding(env)
  const mockOk = adsMockAllowed(env)
  const mock = (): AdsConfig => ({ mode: 'mock', accounts: [mockAdAccountId(orgId)], adAccountId: mockAdAccountId(orgId) })

  if (binding && binding.orgId === orgId) {
    const vault = await vaultAdsFields(orgId)
    const picked = pickAdsCreds(vault, env)
    if (picked.creds) {
      const accounts = [...binding.accounts].sort()
      return { mode: 'live', creds: picked.creds, accounts, adAccountId: accounts[0] }
    }
    // An incomplete set is an operator error to fix, never a reason to fall back.
    if (picked.source === 'none' && mockOk) return mock()
    return { mode: 'not_connected', accounts: [], reason: picked.reason }
  }
  if (!binding && mockOk) return mock()
  return { mode: 'not_connected', accounts: [], reason: NOT_CONNECTED_HERE }
}
