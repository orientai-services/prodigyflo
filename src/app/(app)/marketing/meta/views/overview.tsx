import { Building2 } from 'lucide-react'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { TrendChart } from '@/components/charts/trend-chart'
import { Card, CardContent } from '@/components/ui/card'
import type { AdsDashboard, AdsWindow } from '@/lib/meta/ads/read'
import { WindowTabs } from '../window-tabs'
import {
  AccountStatusPill, Fact, GLOSSARY, Term, count, ctrText, frequencyText, money, unitCost,
} from './parts'

const WINDOW_WORDS: Record<AdsWindow, string> = {
  today: 'today',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  month: 'this month',
  max: 'all time',
}

/** Account card: who pays, how much is owed, and whether Meta is happy with the account. */
export function AccountCardView({ account }: { account: NonNullable<AdsDashboard['account']> }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-full">
            <Building2 aria-hidden className="text-muted-foreground size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{account.name}</p>
            <p className="text-muted-foreground font-mono text-xs break-all">{account.adAccountId}</p>
          </div>
          <AccountStatusPill account={account} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Unpaid balance">{money(account.balance)}</Fact>
          <Fact label="Card on file">{account.card ?? account.cardType ?? '—'}</Fact>
          <Fact label="Spent all time">{money(account.amountSpent)}</Fact>
          <Fact label="Account spending limit">{account.spendCap ? money(account.spendCap) : 'None'}</Fact>
        </dl>
      </CardContent>
    </Card>
  )
}

export function OverviewView({ data, base }: { data: AdsDashboard; base?: string }) {
  const t = data.totals
  const period = WINDOW_WORDS[data.window]
  const daily = data.daily.slice(-30)
  const chartRows = daily.map((d) => ({ label: d.date.slice(5), spend: d.spend, leads: d.leads }))
  const spendSeries = daily.map((d) => d.spend)
  const leadSeries = daily.map((d) => d.leads)

  return (
    <div className="space-y-4">
      <WindowTabs view="overview" active={data.window} base={base} />

      <StatGrid>
        <StatTile label="Spend" value={money(t.spend)} hint={period} sparkline={spendSeries} />
        <StatTile label="Leads" value={count(t.leads)} hint="counted on the day they came in" sparkline={leadSeries} />
        <StatTile label="Cost per lead" value={unitCost(t.cpl)} hint={GLOSSARY.cpl} />
        <StatTile label="Click rate (CTR)" value={ctrText(t.ctr)} hint={GLOSSARY.ctr} />
        <StatTile label="Cost per click (CPC)" value={unitCost(t.cpc)} hint={GLOSSARY.cpc} />
        <StatTile label="Cost per 1,000 views (CPM)" value={unitCost(t.cpm)} hint="Cost for every 1,000 times the ad was shown." />
        <StatTile label="Reach" value={count(t.reach)} hint={GLOSSARY.reach} />
        <StatTile label="Frequency" value={frequencyText(t.frequency)} hint="Average times each person saw the ad." />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendChart
          title="Daily spend"
          description="Last 30 days, including today"
          data={chartRows}
          series={[{ key: 'spend', label: 'Spend', format: 'currencyCents' }]}
          size="sm"
        />
        <TrendChart
          title="Daily leads"
          description="Last 30 days, including today"
          data={chartRows}
          series={[{ key: 'leads', label: 'Leads', format: 'number' }]}
          footnote={GLOSSARY.leads}
          size="sm"
        />
      </div>

      {data.account && <AccountCardView account={data.account} />}

      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Fact label="Campaigns">{count(data.counts.campaigns)}</Fact>
            <Fact label="Ad sets">{count(data.counts.adSets)}</Fact>
            <Fact label="Ads">{count(data.counts.ads)}</Fact>
            <Fact label="Ads running now">{count(data.counts.activeAds)}</Fact>
          </dl>
          <p className="text-muted-foreground mt-3 text-xs">
            <Term tip={GLOSSARY.impressions}>Impressions</Term> {period}: {count(t.impressions)} · Link clicks:{' '}
            {count(t.linkClicks)} · Landing page views: {count(t.landingPageViews)}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
