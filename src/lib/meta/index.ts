import 'server-only'
import { IntakeSourceKind } from '@prisma/client'
import { db } from '@/lib/db'
import { hashValue } from '@/lib/crypto'
import { processInbound } from '@/lib/intake/apply'
import { MockMetaAdsProvider } from './mock'
import { GraphMetaAdsProvider } from './graph'
import {
  credentialsConfigured, metaConfigured, metaCredentialsFor,
  type MetaAdsProvider, type MetaLead,
} from './provider'

let cached: MetaAdsProvider | null = null

/**
 * Mock unless real ENV credentials exist — same selection pattern as the AI
 * provider. The webhook/lead path uses this sync form; ads-management surfaces
 * should prefer getMetaProviderFor, which also consults the credential vault.
 */
export function getMetaProvider(): MetaAdsProvider {
  if (cached && (cached.kind === 'graph') === metaConfigured()) return cached
  cached = metaConfigured() ? new GraphMetaAdsProvider() : new MockMetaAdsProvider()
  return cached
}

/**
 * Org-aware selection: vault credentials first (when the connector vault has
 * META_ADS fields for this org), env fallback, mock when neither is complete.
 */
export async function getMetaProviderFor(organizationId: string): Promise<MetaAdsProvider> {
  const creds = await metaCredentialsFor(organizationId)
  return credentialsConfigured(creds) ? new GraphMetaAdsProvider(creds) : new MockMetaAdsProvider()
}

/**
 * Per-campaign daily spend series from the locally persisted stats — adapter
 * agnostic (both mock and graph write CampaignDailyStat). Returns oldest→newest
 * spend arrays keyed by local campaign id, zero-filled per missing day.
 */
export async function campaignTrends(organizationId: string, days = 7): Promise<Map<string, number[]>> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000)
  const rows = await db.campaignDailyStat.findMany({
    where: { campaign: { organizationId, channel: 'meta' }, date: { gte: new Date(since.toISOString().slice(0, 10)) } },
    select: { campaignId: true, date: true, spend: true },
    orderBy: { date: 'asc' },
  })
  const dayKeys: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  }
  const out = new Map<string, number[]>()
  for (const r of rows) {
    const series = out.get(r.campaignId) ?? new Array(dayKeys.length).fill(0)
    const idx = dayKeys.indexOf(r.date.toISOString().slice(0, 10))
    if (idx >= 0) series[idx] = Number(r.spend)
    out.set(r.campaignId, series)
  }
  return out
}

/** Meta spend accumulated since the first of the current month. */
export async function monthSpend(organizationId: string): Promise<number> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const totals = await db.campaignDailyStat.aggregate({
    where: { campaign: { organizationId, channel: 'meta' }, date: { gte: monthStart } },
    _sum: { spend: true },
  })
  return Number(totals._sum.spend ?? 0)
}

/** The intake source Meta leads flow through — created on first use. */
export async function ensureMetaIntakeSource(organizationId: string) {
  const existing = await db.intakeSource.findFirst({
    where: { organizationId, kind: IntakeSourceKind.META_LEAD_ADS },
  })
  if (existing) return existing
  const leadSource = await db.leadSource.findFirst({
    where: { organizationId, name: { contains: 'Meta', mode: 'insensitive' } },
  })
  return db.intakeSource.create({
    data: {
      organizationId,
      kind: IntakeSourceKind.META_LEAD_ADS,
      name: 'Meta Lead Ads',
      slug: 'meta-lead-ads',
      // Webhook auth is Meta's own X-Hub-Signature-256; no per-source secret.
      secretHash: hashValue(`meta:${organizationId}`),
      fieldMapping: {
        firstName: 'first_name',
        lastName: 'last_name',
        email: 'email',
        phone: 'phone_number',
        utmSource: 'utm_source',
        utmCampaign: 'utm_campaign',
      },
      defaultLeadSourceId: leadSource?.id ?? null,
    },
  })
}

/**
 * Runs one Meta lead through the standard intake pipeline. `leadgenId` is the
 * idempotency key, so Meta's redelivered webhooks can never duplicate a lead.
 */
export async function ingestMetaLead(
  organizationId: string,
  lead: MetaLead,
  attribution: { adExternalId?: string; adSetExternalId?: string; formExternalId?: string } = {},
) {
  const source = await ensureMetaIntakeSource(organizationId)

  const full = (lead.fields.full_name ?? '').trim()
  const [first, ...rest] = full.split(/\s+/)

  // Meta's leadgen webhook carries ad_id + adgroup_id (the ad SET id), never a
  // campaign_id. Resolve the campaign through the locally-synced ad set when we
  // have one; lead capture works fine unattributed when ad sets aren't synced
  // (e.g. a lead-capture-only install with no ad account connected).
  let campaign: { id: string; name: string; utmCampaign: string | null } | null = null
  if (attribution.adSetExternalId) {
    const adSet = await db.adSet.findFirst({
      where: { organizationId, externalId: attribution.adSetExternalId },
      select: { campaignId: true },
    })
    if (adSet?.campaignId) {
      campaign = await db.campaign.findFirst({
        where: { id: adSet.campaignId, organizationId },
        select: { id: true, name: true, utmCampaign: true },
      })
    }
  }

  const payload = {
    ...lead.fields,
    first_name: lead.fields.first_name ?? first ?? '',
    last_name: lead.fields.last_name ?? rest.join(' '),
    utm_source: 'meta',
    utm_campaign: campaign?.utmCampaign ?? campaign?.name ?? undefined,
    leadgen_id: lead.leadgenId,
  }

  const result = await processInbound(source, `leadgen:${lead.leadgenId}`, payload)

  // Attribute the created client to the campaign so spend and leads meet.
  if (campaign && result.submission.clientId) {
    await db.client.updateMany({
      where: { id: result.submission.clientId, campaignId: null },
      data: { campaignId: campaign.id },
    })
  }
  return result
}

export { metaConfigured, metaVerifyToken, metaCredentials, metaCredentialsFor } from './provider'
export type {
  MetaAccountInfo, MetaAdAccountInput, MetaAdSet, MetaAdsProvider, MetaCampaign,
  MetaCampaignInput, MetaDailyStat, MetaLead,
} from './provider'
