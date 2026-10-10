import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, Unplug } from 'lucide-react'
import { can, type SessionUser } from '@/lib/rbac'
import { db } from '@/lib/db'
import { dateTime, relativeTime } from '@/lib/format'
import { adsBinding, allowedAccountsForOrg } from '@/lib/meta/ads/allowlist'
import { ensureSampleAdsData } from '@/lib/meta/ads/manage'
import { allowedMetaCampaignWhere } from '@/lib/meta/ads/where'
import {
  getAdsDashboard, getBillingView, getConnectionView, getCycleView, getFunnelView, parseAdsWindow,
  type AdsDashboard, type FunnelRange,
} from '@/lib/meta/ads/read'
import { EmptyState } from '@/components/empty-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { CampaignDialog } from './meta-islands'
import { MetaConsole } from './meta-console'
import { RefreshButton } from './refresh-button'
import { META_ADS_PATH, ViewTabs, metaHref, type AdsView } from './window-tabs'
import { ModeBadge } from './views/parts'
import { OverviewView } from './views/overview'
import { AdsTreeView } from './views/ads-tree'
import { FunnelViewSection } from './views/funnel'
import { CycleViewSection } from './views/cycle'
import { BillingViewSection } from './views/billing'
import { ConnectionViewSection } from './views/connection'
import { LeadWebhookCard } from './views/webhook'

/**
 * The Meta Ads dashboard body: view strip, sync alerts and the chosen view.
 * `/marketing/meta` wraps it in a page header; Call Center embeds it under its
 * "Ads" tab (`/call-center?tab=ads`) so the ad numbers sit next to the leads
 * they produced. Every link inside is built on `base`, so the embed never
 * navigates away from the desk. State lives in the URL; the server renders
 * from the database only (docs/META_ADS_SCS.md decision 5).
 */

export type AdsParams = Record<string, string | string[] | undefined>

const VIEWS: readonly AdsView[] = ['overview', 'ads', 'funnel', 'cycle', 'billing', 'connection']
const MANAGE_VIEWS: readonly AdsView[] = ['billing', 'connection']

export function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function parseView(v: string | undefined): AdsView | null {
  return VIEWS.includes(v as AdsView) ? (v as AdsView) : null
}

function parseRange(v: string | undefined): FunnelRange {
  return v === '7d' || v === 'all' ? v : '30d'
}

/** Sync problems on top. Old numbers stay visible, labelled as from the last good sync. */
function SyncAlerts({ data, canManage, base }: { data: AdsDashboard; canManage: boolean; base: string }) {
  const { sync } = data
  const now = new Date()
  const backingOff = sync.backoffUntil !== null && sync.backoffUntil > now

  if (sync.mode === 'not_connected') {
    return (
      <Alert>
        <Unplug />
        <AlertTitle>Meta Ads isn&apos;t connected yet</AlertTitle>
        <AlertDescription>
          {canManage ? (
            <>The ads credentials are missing or incomplete. <Link href={metaHref({ view: 'connection' }, base)}>Check the connection</Link>.</>
          ) : (
            'Ask a workspace admin to finish connecting Meta Ads.'
          )}
          {sync.lastFullSyncAt && ` The numbers below are from the last good sync, ${relativeTime(sync.lastFullSyncAt)}.`}
        </AlertDescription>
      </Alert>
    )
  }

  if (!sync.error && !backingOff) return null
  const plain = sync.error
    ? sync.error.plain.replace('{time}', sync.backoffUntil ? dateTime(sync.backoffUntil) : 'a short wait')
    : `Meta asked us to slow down. Numbers will refresh after ${dateTime(sync.backoffUntil)}.`
  const fixable = sync.error && ['token', 'config', 'permission'].includes(sync.error.kind)

  return (
    <Alert variant={sync.error && sync.error.kind !== 'rate' && sync.error.kind !== 'transient' ? 'destructive' : 'default'}>
      <AlertTriangle />
      <AlertTitle>{sync.error ? 'The last sync with Meta didn’t finish' : 'Syncing is paused for a moment'}</AlertTitle>
      <AlertDescription>
        {plain}
        {fixable && canManage && (
          <> <Link href={metaHref({ view: 'connection' }, base)}>Open the connection checklist</Link>.</>
        )}
        {sync.lastFullSyncAt
          ? ` The numbers below are from the last good sync, ${relativeTime(sync.lastFullSyncAt)}.`
          : ''}
      </AlertDescription>
    </Alert>
  )
}

function NoNumbersYet({ mode }: { mode: AdsDashboard['sync']['mode'] }) {
  return (
    <Card>
      <EmptyState
        icon="Megaphone"
        title={mode === 'not_connected' ? 'No numbers to show' : mode === 'mock' ? 'No sample numbers yet' : 'Waiting for the first sync'}
        description={
          mode === 'not_connected'
            ? 'Numbers appear here once Meta Ads is connected and the first sync finishes.'
            : mode === 'mock'
              ? 'Sample numbers load when a manager presses Refresh now.'
              : 'Numbers appear here within about 10 minutes of connecting.'
        }
      />
    </Card>
  )
}

/** Account name, mode and freshness on one line. The page header shows it on its own page; the embed shows it here. */
export function AdsStatusLine({ dashboard, canManage, embedded }: { dashboard: AdsDashboard | null; canManage: boolean; embedded: boolean }) {
  const account = dashboard?.account ?? null
  const sync = dashboard?.sync ?? null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {embedded && (
        <span className="text-sm font-semibold">{account ? account.name : 'Meta Ads'}</span>
      )}
      {embedded && account && <span className="text-muted-foreground font-mono">{account.adAccountId}</span>}
      {sync && <ModeBadge mode={sync.mode} />}
      {sync?.lastFullSyncAt && (
        <span className="text-muted-foreground" title={dateTime(sync.lastFullSyncAt)}>
          Updated {relativeTime(sync.lastFullSyncAt)}
        </span>
      )}
      {sync?.stale && sync.mode !== 'not_connected' && (
        <Badge variant="outline" className="text-warning border-warning/40">Numbers may be out of date</Badge>
      )}
      {embedded && canManage && sync && sync.mode !== 'not_connected' && (
        <span className="ml-auto"><RefreshButton /></span>
      )}
    </div>
  )
}

/** Resolves the view and loads the dashboard. Shared by the page and the embed. */
export async function loadAdsContent(user: SessionUser, params: AdsParams) {
  const canManage = can(user, 'connectors:manage')
  const campaignParam = one(params.campaign)
  const view: AdsView = parseView(one(params.view)) ?? (campaignParam ? 'ads' : 'overview')
  if (MANAGE_VIEWS.includes(view) && !canManage) redirect('/forbidden')

  // Not the bound workspace: no account name, no id, no numbers, and no ads query.
  // allowedAccountsForOrg is [] for every workspace except the bound one; in
  // development and preview it also lists the sample account (never in production).
  if (allowedAccountsForOrg(user.organizationId).length === 0) {
    return { bound: false as const, canManage, view, w: '30d' as const, dashboard: null, campaignParam }
  }

  // Sample mode (development and preview only): fill the sample account once,
  // so the page never waits on a cron that only syncs live accounts.
  await ensureSampleAdsData(user)

  const w = parseAdsWindow(one(params.w))
  const dashboard = await getAdsDashboard(user, view === 'overview' || view === 'ads' ? w : '30d')
  return { bound: true as const, canManage, view, w, dashboard, campaignParam }
}

export async function MetaAdsContent({
  user, params, base = META_ADS_PATH, embedded = false,
}: { user: SessionUser; params: AdsParams; base?: string; embedded?: boolean }) {
  const loaded = await loadAdsContent(user, params)
  const { canManage, view, w, campaignParam } = loaded

  if (!loaded.bound) {
    // Nothing bound anywhere yet is "not set up", not "set up elsewhere".
    const notSetUp = adsBinding() === null
    return (
      <div className="space-y-4">
        {embedded && <AdsStatusLine dashboard={null} canManage={canManage} embedded />}
        <Card>
          <EmptyState
            icon="Unplug"
            title={notSetUp ? "Ads reporting isn't set up yet" : "Meta Ads reporting isn't connected for this workspace."}
            description={
              !notSetUp
                ? 'Ads reporting is only available in the workspace it was set up for.'
                : canManage
                  ? `A server admin needs to set META_ADS_ORG_ID to this workspace's id (${user.organizationId}) and META_ALLOWED_AD_ACCOUNTS to the approved ad account, then save the ads credentials in Connectors → Meta Ads. If both are set, one of them isn't valid.`
                  : 'Ask a workspace admin to finish setting up ads reporting.'
            }
          />
        </Card>
        {canManage && <LeadWebhookCard />}
      </div>
    )
  }

  const { dashboard } = loaded
  const hasNumbers = dashboard.sync.lastFullSyncAt !== null
  const tz = dashboard.account?.timezoneName ?? null

  let body: React.ReactNode
  switch (view) {
    case 'overview':
      body = hasNumbers ? <OverviewView data={dashboard} base={base} /> : <NoNumbersYet mode={dashboard.sync.mode} />
      break
    case 'ads': {
      // ?campaign= only ever resolves through the allowlisted campaign filter.
      const selected = campaignParam
        ? await db.campaign.findFirst({
            where: { AND: [allowedMetaCampaignWhere(user.organizationId), { id: campaignParam }] },
            select: { id: true },
          })
        : null
      const writes = dashboard.writesEnabled && canManage
      body = hasNumbers ? (
        <>
          {writes && (
            <div className="flex justify-end">
              <CampaignDialog />
            </div>
          )}
          <AdsTreeView data={dashboard} selectedId={selected?.id} base={base} />
          {writes && <MetaConsole mode={dashboard.sync.mode === 'mock' ? 'mock' : 'live'} />}
        </>
      ) : (
        <NoNumbersYet mode={dashboard.sync.mode} />
      )
      break
    }
    case 'funnel': {
      const funnel = await getFunnelView(user, parseRange(one(params.range)))
      body = <FunnelViewSection data={funnel} base={base} />
      break
    }
    case 'cycle': {
      const cycle = await getCycleView(user)
      body = <CycleViewSection data={cycle} canManage={canManage} timeZone={tz} />
      break
    }
    case 'billing': {
      const billing = await getBillingView(user)
      body = billing ? (
        <BillingViewSection data={billing} />
      ) : (
        <Card>
          <EmptyState
            icon="CreditCard"
            title="No billing details yet"
            description="Billing shows up after the first balance check with Meta."
          />
        </Card>
      )
      break
    }
    case 'connection': {
      const connection = await getConnectionView(user)
      body = (
        <>
          <ConnectionViewSection data={connection} />
          <LeadWebhookCard />
        </>
      )
      break
    }
  }

  return (
    <div className="space-y-4">
      {embedded && <AdsStatusLine dashboard={dashboard} canManage={canManage} embedded />}
      <ViewTabs active={view} canManage={canManage} w={w} base={base} />
      <SyncAlerts data={dashboard} canManage={canManage} base={base} />
      {view === 'overview' && dashboard.window === 'max' && dashboard.sync.partialMax && hasNumbers && (
        <p className="text-muted-foreground text-xs">
          All-time numbers for single ads are partial: Meta limited how far back it would go. Account and campaign totals
          are complete.
        </p>
      )}
      {body}
    </div>
  )
}
