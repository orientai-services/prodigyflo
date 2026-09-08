import Link from 'next/link'
import { Building2, CheckCircle2, CircleDashed, X } from 'lucide-react'
import { can, requirePermissionPage } from '@/lib/rbac'
import {
  campaignTrends, getMetaProviderFor, metaCredentialsFor, metaVerifyToken, monthSpend,
} from '@/lib/meta'
import { currency, number, percent } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { TrendChart } from '@/components/charts/trend-chart'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { MarketingTabs } from '../marketing-tabs'
import { AdAccountDialog, CampaignDialog, SpendCapForm, TestLeadButton } from './meta-islands'
import { CampaignTable, type CampaignRowView } from './campaign-table'
import { MetaConsole } from './meta-console'
import { Sparkline } from './spark'

export const metadata = { title: 'Meta Ads' }

function KpiTile({
  label, value, hint, data,
}: { label: string; value: string; hint?: string; data?: number[] }) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        {data && data.some((v) => v > 0) && <Sparkline data={data} />}
      </div>
      {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
    </div>
  )
}

export default async function MetaAdsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePermissionPage('connectors:read')
  const canManage = can(user, 'connectors:manage')
  const params = await searchParams
  const selectedId = typeof params.campaign === 'string' ? params.campaign : undefined

  const provider = await getMetaProviderFor(user.organizationId)
  const creds = await metaCredentialsFor(user.organizationId)

  // Campaigns first (mock backfill may write stats), then everything that reads them.
  const campaigns = await provider.listCampaigns(user.organizationId)
  const [adSets, stats, account, trends, spendMonth] = await Promise.all([
    provider.listAdSets(user.organizationId),
    provider.dailyStats(user.organizationId, 30),
    provider.accountInfo(user.organizationId),
    campaignTrends(user.organizationId, 7),
    monthSpend(user.organizationId),
  ])

  const rows: CampaignRowView[] = campaigns.map((c) => ({
    ...c,
    trend7: trends.get(c.id) ?? [0, 0, 0, 0, 0, 0, 0],
    adSets: adSets.filter((a) => a.campaignId === c.id).map((a) => ({
      id: a.id, name: a.name, status: a.status, dailyBudget: a.dailyBudget, spend: a.spend,
    })),
  }))
  const selected = selectedId ? rows.find((r) => r.id === selectedId) : undefined

  const totalSpend = campaigns.reduce((a, c) => a + c.spend, 0)
  const totalLeads = campaigns.reduce((a, c) => a + c.leads, 0)
  const totalImpressions = campaigns.reduce((a, c) => a + c.impressions, 0)
  const totalClicks = campaigns.reduce((a, c) => a + c.clicks, 0)
  const active = campaigns.filter((c) => c.status === 'ACTIVE').length
  const spendSeries = stats.map((s) => s.spend)
  const leadSeries = stats.map((s) => s.leads)

  const base = process.env.APP_URL || 'http://localhost:3300'
  const checklist = [
    { label: 'App ID (META_APP_ID)', done: Boolean(creds.appId), required: true },
    { label: 'App secret (META_APP_SECRET)', done: Boolean(creds.appSecret), required: true },
    { label: 'Page access token (META_PAGE_ACCESS_TOKEN)', done: Boolean(creds.pageAccessToken), required: true },
    { label: 'Ad account id (META_AD_ACCOUNT_ID)', done: Boolean(creds.adAccountId), required: true },
    { label: 'Business id (META_BUSINESS_ID) — ad account creation', done: Boolean(creds.businessId), required: false },
    { label: 'System User token (META_SYSTEM_USER_TOKEN) — ads management', done: Boolean(creds.systemUserToken), required: false },
  ]

  return (
    <div>
      <PageHeader
        title="Meta Ads"
        description="Campaigns, ad sets, spend, and Lead Ads intake for Facebook and Instagram."
        actions={canManage ? <TestLeadButton /> : undefined}
      >
        <MarketingTabs active="meta" />
        {provider.kind === 'mock' && (
          <Badge variant="outline" className="text-warning border-warning/40 mt-3">
            Mock mode — no money moves and no real ads run until Meta credentials are configured below
          </Badge>
        )}
      </PageHeader>

      <div className="space-y-4 p-4 sm:p-6">
        {/* Account bar — the Ads-Manager anchor row, in ProdigyFlo clothes. */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <span className="bg-muted flex size-8 items-center justify-center rounded-full">
              <Building2 className="text-muted-foreground size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{account.name}</p>
              <p className="text-muted-foreground font-mono text-xs">{account.id}</p>
            </div>
            <Badge
              variant="outline"
              className={account.mode === 'live' ? 'text-success border-success/40' : 'text-warning border-warning/40'}
            >
              {account.mode === 'live' ? 'Live' : 'Mock'}
            </Badge>
            <Badge variant="outline">{account.status.toLowerCase()}</Badge>
            <Separator orientation="vertical" className="hidden h-8 sm:block" />
            <div className="text-sm">
              <p className="text-muted-foreground text-xs">This month</p>
              <p className="font-semibold tabular-nums">{currency(spendMonth)}</p>
            </div>
            {account.spendCap !== undefined && (
              <div className="text-sm">
                <p className="text-muted-foreground text-xs">Account cap</p>
                <p className="font-semibold tabular-nums">{currency(account.spendCap)}</p>
              </div>
            )}
            {canManage && (
              <div className="ml-auto flex items-center gap-2">
                <AdAccountDialog mode={account.mode} />
                <CampaignDialog />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Spend (30d shown)"
            value={currency(totalSpend)}
            hint={provider.kind === 'mock' ? 'simulated' : 'from Meta insights'}
            data={spendSeries}
          />
          <KpiTile
            label="Leads attributed"
            value={number(totalLeads)}
            hint="clients linked to a Meta campaign"
            data={leadSeries}
          />
          <KpiTile
            label="Cost per lead"
            value={totalLeads ? currency(totalSpend / totalLeads) : '—'}
            hint={totalLeads ? `n=${totalLeads}` : 'no leads yet'}
          />
          <KpiTile
            label="Active campaigns"
            value={String(active)}
            hint={`${campaigns.length} total · CTR ${totalImpressions ? percent((totalClicks / totalImpressions) * 100, 1) : '—'}`}
          />
        </div>

        <TrendChart
          title="Daily spend"
          description={provider.kind === 'mock' ? 'Simulated series — deterministic, clearly synthetic' : 'Last 30 days from Meta insights (campaign level)'}
          data={stats.map((s) => ({ label: s.date.slice(5), spend: s.spend }))}
          series={[{ key: 'spend', label: 'Spend', format: 'currency' }]}
        />

        <section className={selected ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]' : undefined}>
          <div>
            <h2 className="mb-3 text-sm font-semibold">Campaigns &amp; ad sets</h2>
            {rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon="Megaphone"
                  title="No campaigns yet"
                  description={canManage
                    ? 'Create the first one — in mock mode it costs nothing and exercises the whole workflow, ad sets included.'
                    : 'Campaigns appear here once someone with connector access creates them.'}
                  action={canManage ? <CampaignDialog /> : undefined}
                />
              </Card>
            ) : (
              <CampaignTable campaigns={rows} canManage={canManage} selectedId={selected?.id} />
            )}
          </div>

          {selected && (
            <aside className="lg:pt-8">
              <Card>
                <CardContent className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{selected.name}</h3>
                      <p className="text-muted-foreground font-mono text-xs break-all">{selected.externalId}</p>
                    </div>
                    <Link
                      href="/marketing/meta"
                      scroll={false}
                      className="text-muted-foreground hover:text-foreground rounded p-1"
                      aria-label="Close detail"
                    >
                      <X className="size-4" />
                    </Link>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={selected.status === 'ACTIVE' ? 'secondary' : 'outline'}>{selected.status.toLowerCase()}</Badge>
                    <Badge variant="outline">{selected.objective.toLowerCase()}</Badge>
                  </div>
                  <Sparkline data={selected.trend7} className="h-10 w-full" />
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm tabular-nums">
                    <div><dt className="text-muted-foreground text-xs">Daily budget</dt><dd>{currency(selected.dailyBudget)}</dd></div>
                    <div><dt className="text-muted-foreground text-xs">Spend</dt><dd>{currency(selected.spend)}</dd></div>
                    <div><dt className="text-muted-foreground text-xs">Leads</dt><dd>{number(selected.leads)}</dd></div>
                    <div><dt className="text-muted-foreground text-xs">CPL</dt><dd>{selected.leads ? currency(selected.spend / selected.leads) : '—'}</dd></div>
                    <div><dt className="text-muted-foreground text-xs">Impressions</dt><dd>{number(selected.impressions)}</dd></div>
                    <div><dt className="text-muted-foreground text-xs">Clicks</dt><dd>{number(selected.clicks)}</dd></div>
                  </dl>
                  <Separator />
                  {canManage ? (
                    <SpendCapForm campaignId={selected.id} spendCap={selected.spendCap} />
                  ) : (
                    <p className="text-sm">
                      <span className="text-muted-foreground text-xs">Lifetime cap </span>
                      {selected.spendCap !== null ? currency(selected.spendCap) : 'none'}
                    </p>
                  )}
                  <Separator />
                  <div>
                    <p className="text-muted-foreground mb-1.5 text-xs font-medium">Ad sets</p>
                    {selected.adSets.length === 0 ? (
                      <p className="text-muted-foreground text-xs">None synced yet.</p>
                    ) : (
                      <ul className="space-y-1 text-xs">
                        {selected.adSets.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-2">
                            <span className="truncate">{a.name}</span>
                            <span className="text-muted-foreground shrink-0 tabular-nums">
                              {a.status === 'ACTIVE' ? '●' : '○'} {currency(a.spend)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            </aside>
          )}
        </section>

        {canManage && <MetaConsole mode={provider.kind === 'mock' ? 'mock' : 'live'} />}

        <section className="grid gap-4 lg:grid-cols-2">
          <Card><CardContent className="space-y-3">
            <h2 className="text-sm font-semibold">Connection</h2>
            <ul className="space-y-1.5 text-sm">
              {checklist.map((c) => (
                <li key={c.label} className="flex items-center gap-2">
                  {c.done
                    ? <CheckCircle2 className="text-success size-4 shrink-0" />
                    : <CircleDashed className="text-muted-foreground size-4 shrink-0" />}
                  <span className={c.done ? '' : 'text-muted-foreground'}>
                    {c.label}
                    {!c.required && <span className="text-muted-foreground text-xs"> (optional)</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              {provider.kind === 'graph'
                ? 'Credentials present — the Graph adapter is live. Watch the first campaign closely. Page tokens usually cannot manage ads; set META_SYSTEM_USER_TOKEN for campaign/budget writes.'
                : 'Set these in /etc/prodigyflo.env (or .env locally) and restart — or store them in the connector credential vault. Until then everything runs against the labelled mock.'}
            </p>
          </CardContent></Card>

          <Card><CardContent className="space-y-3">
            <h2 className="text-sm font-semibold">Lead Ads webhook</h2>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs uppercase tracking-wide">Callback URL</dt>
                <dd className="font-mono text-xs break-all">{base}/api/meta/leads</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs uppercase tracking-wide">Verify token</dt>
                <dd className="font-mono text-xs break-all">{metaVerifyToken()}</dd>
              </div>
            </dl>
            <p className="text-muted-foreground text-xs">
              Paste both into Meta → App Dashboard → Webhooks → Page → <code>leadgen</code>. Delivered
              leads run through the standard intake pipeline: replay-proof, deduped, audited, and
              attributed to their campaign. The CLI can do the subscription for you:
              <code className="bg-muted ml-1 rounded px-1 py-0.5">node tools/meta.mjs subscribe</code>
            </p>
          </CardContent></Card>
        </section>
      </div>
    </div>
  )
}
