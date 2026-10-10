/**
 * Classify legacy Meta campaigns and ad sets (docs/META_ADS_SCS.md §3.7).
 * Dry run unless --commit. Bound workspace only, live mode only.
 *
 * Every meta Campaign and AdSet that predates the ad-account column has
 * adAccountId = NULL and is hidden everywhere. For each one with a real
 * (non-mock) external id this asks Graph, through the guarded client, which
 * account it belongs to (fields=account_id only). Allowed → adAccountId is set
 * and the row becomes visible. Anything else stays NULL and hidden. Output is
 * counts only, never names or ids of hidden rows.
 *
 *   npx tsx --conditions=react-server scripts/meta-ads-classify-legacy.ts [--commit]
 */
import 'dotenv/config'
import { db } from '@/lib/db'
import { adsBinding } from '@/lib/meta/ads/allowlist'
import { resolveAdsConfig } from '@/lib/meta/ads/config'
import { GraphAdsSource, type AdsSource } from '@/lib/meta/ads/source'

export type ClassifyCounts = {
  campaigns: { checked: number; allowed: number; hidden: number; skippedMock: number }
  adSets: { checked: number; allowed: number; hidden: number; skippedMock: number }
}

export async function classifyLegacy(opts: {
  commit?: boolean
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  source?: AdsSource
  log?: (line: string) => void
} = {}): Promise<ClassifyCounts | { refused: string }> {
  const env = opts.env ?? process.env
  const log = opts.log ?? (() => {})
  const binding = adsBinding(env)
  if (!binding) return { refused: 'META_ADS_ORG_ID and META_ALLOWED_AD_ACCOUNTS must both be set.' }
  const orgId = binding.orgId
  const config = await resolveAdsConfig(orgId, env)
  if (config.mode !== 'live' || !config.creds || !config.adAccountId) return { refused: `Ads reporting is ${config.mode}; this needs live credentials.` }
  const acct = await db.metaAdAccount.findUnique({ where: { adAccountId: config.adAccountId }, select: { tokenAppId: true, organizationId: true } })
  if (acct && acct.organizationId !== orgId) return { refused: 'The ad account is held by a different workspace.' }
  const source = opts.source ?? new GraphAdsSource(config.adAccountId, {
    orgId, token: config.creds.token, appId: config.creds.appId, appSecret: config.creds.appSecret,
    tokenAppId: acct?.tokenAppId ?? null, fetchImpl: opts.fetchImpl, env,
  })

  const counts: ClassifyCounts = {
    campaigns: { checked: 0, allowed: 0, hidden: 0, skippedMock: 0 },
    adSets: { checked: 0, allowed: 0, hidden: 0, skippedMock: 0 },
  }
  const campaigns = await db.campaign.findMany({ where: { organizationId: orgId, channel: 'meta', adAccountId: null, externalId: { not: null } }, select: { id: true, externalId: true } })
  for (const c of campaigns) {
    if (c.externalId!.startsWith('mock_')) { counts.campaigns.skippedMock++; continue }
    counts.campaigns.checked++
    const verdict = await source.ownership(c.externalId!).catch(() => 'no_access' as const)
    if (verdict === 'allowed') {
      counts.campaigns.allowed++
      if (opts.commit) await db.campaign.update({ where: { id: c.id }, data: { adAccountId: config.adAccountId } })
    } else counts.campaigns.hidden++
  }
  const adSets = await db.adSet.findMany({ where: { organizationId: orgId, adAccountId: null, externalId: { not: null } }, select: { id: true, externalId: true } })
  for (const s of adSets) {
    if (s.externalId!.startsWith('mock')) { counts.adSets.skippedMock++; continue }
    counts.adSets.checked++
    const verdict = await source.ownership(s.externalId!).catch(() => 'no_access' as const)
    if (verdict === 'allowed') {
      counts.adSets.allowed++
      if (opts.commit) await db.adSet.update({ where: { id: s.id }, data: { adAccountId: config.adAccountId } })
    } else counts.adSets.hidden++
  }
  log(`Campaigns: checked ${counts.campaigns.checked}, approved account ${counts.campaigns.allowed}, stay hidden ${counts.campaigns.hidden}, mock skipped ${counts.campaigns.skippedMock}.`)
  log(`Ad sets: checked ${counts.adSets.checked}, approved account ${counts.adSets.allowed}, stay hidden ${counts.adSets.hidden}, mock skipped ${counts.adSets.skippedMock}.`)
  if (!opts.commit) log('Dry run. Nothing was changed. Re-run with --commit to apply.')
  return counts
}

const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/meta-ads-classify-legacy.ts')
if (isMain) {
  classifyLegacy({ commit: process.argv.includes('--commit'), log: (l) => console.log(l) })
    .then((r) => {
      if ('refused' in r) {
        console.error(r.refused)
        process.exit(1)
      }
      process.exit(0)
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : 'Classification failed.')
      process.exit(1)
    })
}
