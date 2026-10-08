import 'server-only'
import type {
  MetaAccountInfo, MetaAdSet, MetaAdsProvider, MetaCampaign, MetaDailyStat, MetaLead,
} from './provider'

const NOT_CONNECTED = "Meta Ads isn't connected."

/**
 * What production gets when no Meta credentials are configured: reads are
 * empty, writes and lead reads throw, and nothing is ever written. The mock
 * provider is only selected where adsMockAllowed() (dev, test, preview).
 */
export class DisconnectedMetaAdsProvider implements MetaAdsProvider {
  readonly kind = 'disconnected' as const

  async listCampaigns(): Promise<MetaCampaign[]> { return [] }
  async listAdSets(): Promise<MetaAdSet[]> { return [] }
  async dailyStats(): Promise<MetaDailyStat[]> { return [] }
  async accountInfo(): Promise<MetaAccountInfo> {
    return { id: '—', name: 'Ad account not connected', currency: 'USD', status: 'NOT_CONNECTED', mode: 'live' }
  }
  async createCampaign(): Promise<MetaCampaign> { throw new Error(NOT_CONNECTED) }
  async setCampaignStatus(): Promise<void> { throw new Error(NOT_CONNECTED) }
  async updateDailyBudget(): Promise<void> { throw new Error(NOT_CONNECTED) }
  async setCampaignSpendCap(): Promise<void> { throw new Error(NOT_CONNECTED) }
  async setAdSetStatus(): Promise<void> { throw new Error(NOT_CONNECTED) }
  async updateAdSetBudget(): Promise<void> { throw new Error(NOT_CONNECTED) }
  async createAdAccount(): Promise<{ id: string; mode: 'mock' | 'live' }> { throw new Error(NOT_CONNECTED) }
  async fetchLead(): Promise<MetaLead> { throw new Error(NOT_CONNECTED) }
}
