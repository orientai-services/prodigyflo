/**
 * Connect the approved Meta ad account to its one workspace
 * (docs/META_ADS_SCS.md §5.1). Read-only unless --commit. Never writes a token:
 * the token goes in through Connectors → Meta Ads (Ads fields) or the env.
 *
 *   npx tsx --conditions=react-server scripts/meta-ads-connect.ts                       # print workspaces, change nothing
 *   npx tsx --conditions=react-server scripts/meta-ads-connect.ts --org-id <Organization.id> --account act_<digits> --check
 *   npx tsx --conditions=react-server scripts/meta-ads-connect.ts --org-id <id> --account act_<digits> --commit [--start-cycle]
 */
import 'dotenv/config'
import { db } from '@/lib/db'
import { adsBinding, normalizeAdAccountId } from '@/lib/meta/ads/allowlist'
import { resolveAdsConfig } from '@/lib/meta/ads/config'
import {
  GraphAdsSource, targetsNarrow, type AdsSource, type TokenInfo, type TokenTargets, type VisibleAccounts,
} from '@/lib/meta/ads/source'
import { resolveMetaOrg } from '@/lib/meta/webhook-context'
import { metaCredentials } from '@/lib/meta/provider'
import { countNamedAttributionRows } from './meta-attribution-scrub'

type Env = Record<string, string | undefined>

export type ConnectOptions = {
  orgId?: string
  adAccountId?: string
  commit?: boolean
  check?: boolean
  startCycle?: boolean
  env?: Env
  fetchImpl?: typeof fetch
  /** Test seam: a source to use for --check instead of the Graph one. */
  source?: AdsSource
}

export type ConnectResult = { lines: string[]; refused: string[]; committed: boolean; alreadyConnected: boolean }

const ADS_FIELDS = ['adsAppId', 'adsAppSecret', 'adsSystemUserToken']
const INTAKE_FIELDS = ['appId', 'appSecret', 'systemUserToken', 'pageAccessToken']

export async function connectMetaAds(opts: ConnectOptions): Promise<ConnectResult> {
  const env = opts.env ?? process.env
  const lines: string[] = []
  const refused: string[] = []
  const out = (l: string) => lines.push(l)
  const result: ConnectResult = { lines, refused, committed: false, alreadyConnected: false }

  // 1. Print every live workspace (names of fields only, never values).
  const orgs = await db.organization.findMany({ where: { deletedAt: null }, select: { id: true, slug: true, name: true }, orderBy: { createdAt: 'asc' } })
  const leadOrg = await resolveMetaOrg()
  out('Workspaces:')
  for (const o of orgs) {
    const connector = await db.connector.findUnique({ where: { organizationId_kind: { organizationId: o.id, kind: 'META_ADS' } }, select: { id: true, credentials: { select: { fieldKey: true } } } })
    const keys = connector?.credentials.map((c) => c.fieldKey) ?? []
    const source = await db.intakeSource.findFirst({ where: { organizationId: o.id, kind: 'META_LEAD_ADS', isEnabled: true }, select: { id: true } })
    out(`  ${o.id}  ${o.slug}  "${o.name}"  META_ADS connector: ${connector ? 'yes' : 'no'}  intake fields: [${keys.filter((k) => INTAKE_FIELDS.includes(k)).join(', ')}]  ads fields: [${keys.filter((k) => ADS_FIELDS.includes(k)).join(', ')}]  lead source: ${source ? 'enabled' : 'none'}`)
  }
  out(`Workspace that receives Meta leads (resolveMetaOrg): ${leadOrg?.id ?? 'none'}`)
  out(`META_ADS_ORG_ID: ${env.META_ADS_ORG_ID || '(unset)'}`)
  out(`META_ALLOWED_AD_ACCOUNTS: ${env.META_ALLOWED_AD_ACCOUNTS || '(unset)'}`)
  if (!opts.orgId) {
    out('No --org-id given: stopping after the listing. Nothing was changed.')
    return result
  }

  // 2. Refusals for --commit.
  const binding = adsBinding(env)
  const account = opts.adAccountId ? normalizeAdAccountId(opts.adAccountId) : null
  if (!binding) refused.push('META_ADS_ORG_ID and META_ALLOWED_AD_ACCOUNTS must both be set and valid.')
  else if (binding.orgId !== opts.orgId) refused.push('META_ADS_ORG_ID does not equal --org-id.')
  if (!account) refused.push('--account must be act_ followed by digits.')
  else if (binding && !binding.accounts.has(account)) refused.push('--account is not in META_ALLOWED_AD_ACCOUNTS.')
  if (!leadOrg || leadOrg.id !== opts.orgId) refused.push('--org-id is not the workspace that receives Meta leads.')
  if (account) {
    const holder = await db.metaAdAccount.findUnique({ where: { adAccountId: account }, select: { organizationId: true } })
    if (holder && holder.organizationId !== opts.orgId) refused.push('Another workspace already holds this ad account.')
    if (holder && holder.organizationId === opts.orgId) result.alreadyConnected = true
  }
  const named = await countNamedAttributionRows()
  if (named > 0) refused.push(`The attribution scrub still finds ${named} named rows. Run scripts/meta-attribution-scrub.ts --commit first.`)

  // 3. --check (also required by --commit).
  let info: TokenInfo | null = null
  let visible: VisibleAccounts | null = null
  const config = await resolveAdsConfig(opts.orgId, env)
  if (opts.check || opts.commit) {
    if (config.mode !== 'live' || !config.creds || !account) {
      refused.push(`Ads credentials aren't live for this workspace (${config.reason ?? config.mode}).`)
    } else {
      const source = opts.source ?? new GraphAdsSource(account, {
        orgId: opts.orgId, token: config.creds.token, appId: config.creds.appId, appSecret: config.creds.appSecret,
        tokenAppId: null, fetchImpl: opts.fetchImpl, env,
      })
      try {
        info = await source.tokenInfo()
        const targets = info.adsRead
        out(`Token valid: ${info.valid ? 'yes' : 'no'}  app: ${info.appId ?? 'unknown'}  type: ${info.type ?? 'unknown'}  expires: ${info.expiresAt ? info.expiresAt.toISOString() : 'never'}`)
        out(`ads_read targets: ${describeTargets(targets)}`)
        if (info.adsManagement) out(`ads_management is granted: ${describeTargets(info.adsManagement)}.`)
        const acct = await source.account()
        out(`Account: "${acct.name ?? '?'}"  currency ${acct.currency ?? '?'}  status ${acct.account_status ?? '?'}  timezone ${acct.timezone_name ?? '?'}`)
        visible = await source.visibleAccounts()
        out(`Token sees other accounts: ${visible.othersVisible ? 'yes' : 'no'}`)
        const intakeApp = metaCredentials().appId
        out(`Ads app id equals the lead-intake app id: ${intakeApp && intakeApp === config.creds.appId ? 'yes' : 'no'} (information only)`)
      } catch (e) {
        refused.push(`Check failed: ${e instanceof Error ? e.message : 'unknown error'}`)
      }
    }
  }

  if (!opts.commit) {
    out(refused.length ? `Would refuse --commit:\n  - ${refused.join('\n  - ')}` : 'All checks pass. Nothing was changed (no --commit).')
    return result
  }

  // 4. --commit additionally needs the token to be ours and narrow.
  if (info) {
    // Against the credential set actually in use (vault or env, never mixed).
    if (!config.creds || info.appId !== config.creds.appId) refused.push("The token's app is not the ads app ID.")
    if (info.type !== 'SYSTEM_USER') refused.push('The token is not a system user token.')
    const t = info.adsRead
    if (!t) refused.push('The token has no ads_read.')
    else if ('all' in t) refused.push('ads_read covers all accounts; limit it to the approved account.')
    else if ('others' in t && (t.others > 0 || t.allowed.length === 0)) refused.push('ads_read must cover only approved accounts.')
    // me/adaccounts is the real test of narrowness, including for a system
    // user whose debug_token lists no target ids.
    if (!visible) refused.push("Couldn't list the ad accounts this token can reach.")
    else if (visible.othersVisible) refused.push('The token can reach other ad accounts.')
    else if (t && !targetsNarrow(t, visible)) refused.push('The token reaches none of the approved accounts.')
  }
  if (refused.length) {
    out(`Refused --commit:\n  - ${refused.join('\n  - ')}`)
    return result
  }

  // 5. Commit.
  const orgId = opts.orgId
  const cycleDays = Number(env.META_ADS_CYCLE_DAYS) >= 1 && Number(env.META_ADS_CYCLE_DAYS) <= 90 ? Math.floor(Number(env.META_ADS_CYCLE_DAYS)) : 15
  let changed = false
  let row = await db.metaAdAccount.findUnique({ where: { adAccountId: account! } })
  // The token's app from the check above, so the first sync already knows it.
  const tokenAppId = info?.appId ?? null
  if (!row) {
    row = await db.metaAdAccount.create({ data: { organizationId: orgId, adAccountId: account!, cycleDays, tokenAppId } })
    changed = true
  } else if (tokenAppId && row.tokenAppId !== tokenAppId) {
    row = await db.metaAdAccount.update({ where: { id: row.id }, data: { tokenAppId } })
  }
  if (opts.startCycle) {
    const open = await db.metaSpendCycle.findFirst({ where: { organizationId: orgId, adAccountId: account!, endedAt: null } })
    const any = await db.metaSpendCycle.findFirst({ where: { organizationId: orgId, adAccountId: account! }, orderBy: { number: 'desc' } })
    if (!open) {
      await db.metaSpendCycle.create({ data: { organizationId: orgId, adAccountId: account!, number: (any?.number ?? 0) + 1, lengthDays: row.cycleDays, startedAt: new Date() } })
      changed = true
    }
  }
  if (!changed) {
    out('Already connected. Nothing was changed.')
    return { ...result, alreadyConnected: true }
  }
  await db.auditEvent.create({
    data: { organizationId: orgId, actorLabel: 'script:meta-ads-connect', action: 'meta.ads.connected', entityType: 'MetaAdAccount', entityId: row.id, summary: 'Approved ad account connected' },
  })
  out('Connected. The next cron run (or Refresh now) fills the dashboard.')
  return { ...result, committed: true }
}

function describeTargets(t: TokenTargets): string {
  if (!t) return 'not granted'
  if ('all' in t) return 'ALL ACCOUNTS'
  if ('unreported' in t) return 'not listed by Meta (system user: checked against the accounts it can reach)'
  return `${t.allowed.join(', ') || 'none allowed'}${t.others ? ` plus ${t.others} other account(s)` : ''}`
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

const isMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/meta-ads-connect.ts')
if (isMain) {
  connectMetaAds({
    orgId: arg('--org-id'),
    adAccountId: arg('--account'),
    commit: process.argv.includes('--commit'),
    check: process.argv.includes('--check'),
    startCycle: process.argv.includes('--start-cycle'),
  })
    .then((r) => {
      for (const l of r.lines) console.log(l)
      process.exit(r.refused.length && process.argv.includes('--commit') ? 1 : 0)
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : 'Connect failed.')
      process.exit(1)
    })
}
