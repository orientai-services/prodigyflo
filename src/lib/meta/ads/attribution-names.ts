import 'server-only'
import { db } from '@/lib/db'
import { attributionRows, type AttributionNames, type AttributionRow } from '@/lib/meta/attribution'
import { allowedAccountsForOrg } from './allowlist'
import { allowedMetaAdSetWhere, allowedMetaOnlyCampaignWhere } from './where'

/**
 * Lead-source rows for a profile, with Campaign / Ad set / Ad names looked up
 * at read time from synced rows of the approved ad account only (P0-A,
 * docs/META_ADS_SCS.md §3.9). An id that doesn't resolve never shows a name or
 * an id. "Outside the connected ad account" is shown only when that is proven
 * (the lead's touch is outside, or Meta said the ad is in another account);
 * otherwise the row reads "Not matched to an ad yet". A workspace with no ads
 * reporting gets no ad rows at all.
 */
export async function attributionRowsFor(orgId: string, raw: unknown): Promise<AttributionRow[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const a = raw as { provider?: unknown; leadgenId?: unknown; campaignId?: unknown; adsetId?: unknown; adId?: unknown }
  if (a.provider !== 'meta') return []
  const accounts = allowedAccountsForOrg(orgId)
  // Not the bound workspace (or nothing bound): no ads lookups, no ad rows.
  if (accounts.length === 0) return attributionRows(raw)

  const id = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : typeof v === 'number' ? String(v) : null)
  const campaignId = id(a.campaignId), adsetId = id(a.adsetId), adId = id(a.adId)
  const leadgenId = typeof a.leadgenId === 'string' && a.leadgenId ? a.leadgenId.slice(0, 100) : null

  const [campaign, adset, ad, touch, owner] = await Promise.all([
    campaignId ? db.campaign.findFirst({ where: { ...allowedMetaOnlyCampaignWhere(orgId), externalId: campaignId }, select: { name: true } }) : null,
    adsetId ? db.adSet.findFirst({ where: { ...allowedMetaAdSetWhere(orgId), externalId: adsetId }, select: { name: true } }) : null,
    adId ? db.metaAd.findFirst({ where: { organizationId: orgId, externalId: adId, adAccountId: { in: accounts } }, select: { name: true } }) : null,
    leadgenId
      ? db.metaLeadTouch.findUnique({ where: { organizationId_leadgenId: { organizationId: orgId, leadgenId } }, select: { status: true } })
      : null,
    adId ? db.metaObjectAccount.findUnique({ where: { objectId: adId }, select: { outside: true, reason: true } }) : null,
  ])
  const names: AttributionNames = {
    campaignName: campaign?.name ?? null,
    adsetName: adset?.name ?? null,
    adName: ad?.name ?? null,
    outside: touch?.status === 'outside' || Boolean(owner?.outside && owner.reason === 'other_account'),
  }
  return attributionRows(raw, names)
}
