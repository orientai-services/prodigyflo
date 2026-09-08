import 'server-only'
import { hashValue } from '@/lib/crypto'

/**
 * Contract for the Meta (Facebook) Ads integration. Two implementations:
 * a DB-backed mock (default) and the Graph API adapter, selected by whether
 * real credentials are present. Everything the UI renders goes through this
 * interface, so the mock exercises the identical workflow.
 */

export type MetaCampaignInput = {
  name: string
  objective: 'LEADS' | 'TRAFFIC' | 'AWARENESS' | 'CONVERSIONS'
  dailyBudget: number // USD
  status: 'ACTIVE' | 'PAUSED'
}

export type MetaCampaign = {
  id: string          // local Campaign.id
  externalId: string  // Meta campaign id (mock ids are prefixed "mock_")
  name: string
  objective: string
  status: string
  dailyBudget: number
  /** Lifetime spend cap in USD — Meta's spend_cap, NOT a daily number. */
  spendCap: number | null
  spend: number
  impressions: number
  clicks: number
  leads: number
}

export type MetaAdSet = {
  id: string          // local AdSet.id
  campaignId: string  // local Campaign.id
  externalId: string
  name: string
  status: 'ACTIVE' | 'PAUSED'
  dailyBudget: number
  spend: number
}

export type MetaAdAccountInput = {
  name: string
  currency: string
  /** Meta's numeric timezone_id (see the Marketing API timezone-ids table). */
  timezone: string
}

export type MetaAccountInfo = {
  id: string
  name: string
  currency: string
  /** Lifetime account spend cap in USD, when one is set. */
  spendCap?: number
  /** Lifetime amount spent in USD, when Meta reports it. */
  amountSpent?: number
  status: string
  mode: 'mock' | 'live'
}

export type MetaDailyStat = { date: string; spend: number; impressions: number; clicks: number; leads: number }

export type MetaLead = {
  leadgenId: string
  createdTime: string
  fields: Record<string, string> // field_name -> value, e.g. full_name/email/phone_number
}

export interface MetaAdsProvider {
  readonly kind: 'mock' | 'graph'
  listCampaigns(organizationId: string): Promise<MetaCampaign[]>
  createCampaign(organizationId: string, input: MetaCampaignInput): Promise<MetaCampaign>
  setCampaignStatus(organizationId: string, campaignId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>
  updateDailyBudget(organizationId: string, campaignId: string, dailyBudget: number): Promise<void>
  /** Lifetime cap in USD (min $100, enforced via spendCapToCents). */
  setCampaignSpendCap(organizationId: string, campaignId: string, spendCapUsd: number): Promise<void>
  listAdSets(organizationId: string, campaignId?: string): Promise<MetaAdSet[]>
  setAdSetStatus(organizationId: string, adSetId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>
  updateAdSetBudget(organizationId: string, adSetId: string, dailyBudget: number): Promise<void>
  createAdAccount(organizationId: string, input: MetaAdAccountInput): Promise<{ id: string; mode: 'mock' | 'live' }>
  accountInfo(organizationId: string): Promise<MetaAccountInfo>
  dailyStats(organizationId: string, days: number): Promise<MetaDailyStat[]>
  fetchLead(leadgenId: string): Promise<MetaLead>
}

export type MetaCredentials = {
  appId?: string
  appSecret?: string
  pageAccessToken?: string
  adAccountId?: string
  /** Business Manager id — required only for ad-account creation. */
  businessId?: string
  /**
   * System User token with ads_management. Page tokens typically 403 on ads
   * calls, so when this is present the graph adapter prefers it for everything
   * under /act_X and for POST /{business_id}/adaccount.
   */
  systemUserToken?: string
}

export function metaCredentials(): MetaCredentials {
  return {
    appId: process.env.META_APP_ID || undefined,
    appSecret: process.env.META_APP_SECRET || undefined,
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || undefined,
    adAccountId: process.env.META_AD_ACCOUNT_ID || undefined,
    businessId: process.env.META_BUSINESS_ID || undefined,
    systemUserToken: process.env.META_SYSTEM_USER_TOKEN || undefined,
  }
}

/**
 * Vault-first credential resolution: when the connector credential vault (B2)
 * exposes decrypted META_ADS credentials for this org they win field-by-field,
 * with env vars as the fallback. The vault helper is reached through a dynamic
 * import so this module keeps working (env-only) while the vault ships — and
 * any vault failure (missing VAULT_KEY, absent helper) degrades silently to env.
 */
export async function metaCredentialsFor(organizationId: string): Promise<MetaCredentials> {
  const env = metaCredentials()
  try {
    const mod = (await import('@/lib/connectors/credentials')) as unknown as {
      getConnectorCredentials?: (organizationId: string, kind: string) => Promise<Record<string, string> | null>
    }
    if (typeof mod.getConnectorCredentials === 'function') {
      const vault = await mod.getConnectorCredentials(organizationId, 'META_ADS')
      if (vault) {
        return {
          appId: vault.appId || env.appId,
          appSecret: vault.appSecret || env.appSecret,
          pageAccessToken: vault.pageAccessToken || env.pageAccessToken,
          adAccountId: vault.adAccountId || env.adAccountId,
          businessId: vault.businessId || env.businessId,
          systemUserToken: vault.systemUserToken || env.systemUserToken,
        }
      }
    }
  } catch {
    // Vault unavailable — env-only is the documented degradation.
  }
  return env
}

export function credentialsConfigured(c: MetaCredentials): boolean {
  // Lead-ingestion needs an app id + app secret (for the webhook signature) and
  // one token that can read leadgen data. A Page access token is the classic
  // choice, but a System User token carrying leads_retrieval reads leads just as
  // well — accepting either lets an install go live on a single system-user
  // token instead of forcing a separate Page token to be minted.
  return Boolean(c.appId && c.appSecret && (c.pageAccessToken || c.systemUserToken))
}

export function metaConfigured(): boolean {
  return credentialsConfigured(metaCredentials())
}

/**
 * The webhook verify token Meta echoes back during subscription. Derived from
 * AUTH_SECRET so every install has one without another secret to manage.
 */
export function metaVerifyToken(): string {
  return hashValue('meta-webhook-verify').slice(0, 32)
}
