import 'server-only'
import type { Prisma } from '@prisma/client'
import { allowedAccountsForOrg } from './allowlist'

/**
 * Where-fragments for every existing consumer of Campaign / AdSet /
 * CampaignDailyStat (docs/META_ADS_SCS.md §3.7). Non-meta campaigns are
 * untouched. A meta campaign is visible only when its adAccountId is one this
 * workspace may read, so legacy rows (adAccountId NULL), rows of any other ad
 * account, and mock rows outside mock mode are hidden everywhere.
 */

export function allowedMetaCampaignWhere(orgId: string): Prisma.CampaignWhereInput {
  return {
    organizationId: orgId,
    OR: [
      { channel: { not: 'meta' } },
      { channel: 'meta', adAccountId: { in: allowedAccountsForOrg(orgId) } },
    ],
  }
}

/** Meta campaigns only, allowed only. */
export function allowedMetaOnlyCampaignWhere(orgId: string): Prisma.CampaignWhereInput {
  return { organizationId: orgId, channel: 'meta', adAccountId: { in: allowedAccountsForOrg(orgId) } }
}

export function allowedMetaAdSetWhere(orgId: string): Prisma.AdSetWhereInput {
  return { organizationId: orgId, adAccountId: { in: allowedAccountsForOrg(orgId) } }
}

export function allowedCampaignDailyStatWhere(orgId: string): Prisma.CampaignDailyStatWhereInput {
  return { campaign: allowedMetaCampaignWhere(orgId) }
}

/** Daily stats of allowed META campaigns only. */
export function allowedMetaDailyStatWhere(orgId: string): Prisma.CampaignDailyStatWhereInput {
  return { campaign: allowedMetaOnlyCampaignWhere(orgId) }
}

/**
 * The name of a campaign linked to a record, or null when it is a Meta
 * campaign this workspace may not read (legacy links made before the
 * allowlist, or any other ad account). Non-meta campaigns always show.
 */
export function visibleCampaignName(
  orgId: string,
  campaign: { name: string; channel: string; adAccountId: string | null } | null | undefined,
): string | null {
  if (!campaign) return null
  if (campaign.channel !== 'meta') return campaign.name
  return campaign.adAccountId !== null && allowedAccountsForOrg(orgId).includes(campaign.adAccountId) ? campaign.name : null
}
