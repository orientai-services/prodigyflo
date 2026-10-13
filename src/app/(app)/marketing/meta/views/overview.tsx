import { Building2 } from 'lucide-react'
import { StatGrid, StatTile } from '@/components/stat-tile'
import { TrendChart } from './lazy-islands'
import { Card, CardContent } from '@/components/ui/card'
import type { AdsDashboard, AdsWindow } from '@/lib/meta/ads/read'
import { WindowTabs } from '../window-tabs'
import { spentCounterText } from '@/lib/meta/ads/scope'
import {
  AccountStatusPill, Fact, GLOSSARY, Term, count, ctrText, frequencyText, money, unitCost,
} from './parts'

export const WINDOW_WORDS: Record<AdsWindow, string> = {
  today: 'today',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  month: 'this month',
  max: 'all time',
}

/**
 * Billing card: who pays, how much is owed, and whether Meta is happy with the
 * account. The account's name and id sit once at the top of the tab, so this
 * card doesn't repeat them. Meta's `amount_spent` is labelled for what it is:
 * with a spending limit set it restarts at $0 whenever the limit is reset, so
 * it is never called "all time" (that number comes from the insights instead).
 */
export function AccountCardView({
  account, allTimeSpend,
}: { account: NonNullable<AdsDashboard['account']>; allTimeSpend?: number | null }) {
  const counter = spentCounterText(account.spendCap)
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-full">
            <Building2 aria-hidden className="text-muted-foreground size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Billing · {account.name}</p>
            <p className="text-muted-foreground text-xs">From Meta&apos;s billing counters, not the ad results above.</p>
          </div>
          <AccountStatusPill account={account} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Unpaid balance">{money(account.balance)}</Fact>
          <Fact label="Card on file">{account.card ?? account.cardType ?? '—'}</Fact>
          <Fact label={<Term tip={counter.tip}>{counter.label}</Term>}>
            {money(account.amountSpent)}
            {account.spendCap ? <span className="text-muted-foreground font-normal"> of {money(account.spendCap)}</span> : null}
          </Fact>
          {allTimeSpend !== undefined ? (
            <Fact label={<Term tip="Every dollar this ad account has spent, from Meta's ad results. Same source as the Spend tile.">Spent all time (ad results)</Term>}>
              {money(allTimeSpend)}
            </Fact>
          ) : (
            <Fact label="Account spending limit">{account.spendCap ? money(account.spendCap) : 'None'}</Fact>
          )}
        </dl>
      </CardContent>
    </Card>
  )
}

export function OverviewView({ data, base }: { data: AdsDashboard; base?: string }) {
  const t = data.totals
  const period = WINDOW_WORDS[data.window]
  const name = data.account?.name ?? 'this ad account'
  const span = data.period ? ` (${data.period})` : ''
  const daily = data.daily.slice(-30)
  const chartRows = daily.map((d) => ({ label: d.date.slice(5), spend: d.spend, leads: d.leads }))
  const spendSeries = daily.map((d) => d.spend)
  const leadSeries = daily.map((d) => d.leads)

  return (
    <div className="space-y-4">
      <WindowTabs view="overview" active={data.window} base={base} />

      <p className="text-muted-foreground text-xs">
        Every number on this tab is for <span className="text-foreground font-medium">{name}</span> only. The tiles cover{' '}
        {period}
        {span}.
      </p>

      <StatGrid>
        <StatTile label={`Spend · ${period}`} value={money(t.spend)} hint={`${name}${span}`} sparkline={spendSeries} />
        <StatTile label={`Leads · ${period}`} value={count(t.leads)} hint="Meta lead forms, counted on the day they came in" sparkline={leadSeries} />
        <StatTile label="Cost per lead" value={unitCost(t.cpl)} hint={`${GLOSSARY.cpl} ${period}`} />
        <StatTile label="Click rate (CTR)" value={ctrText(t.ctr)} hint={GLOSSARY.ctr} />
        <StatTile label="Cost per click (CPC)" value={unitCost(t.cpc)} hint={GLOSSARY.cpc} />
        <StatTile label="Cost per 1,000 views (CPM)" value={unitCost(t.cpm)} hint="Cost for every 1,000 times the ad was shown." />
        <StatTile label={`Reach · ${period}`} value={count(t.reach)} hint={GLOSSARY.reach} />
        <StatTile label="Frequency" value={frequencyText(t.frequency)} hint="Average times each person saw the ad." />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendChart
          title={`Daily spend · ${name}`}
          description="Last 30 days including today (the 30-day tile ends yesterday)"
          data={chartRows}
          series={[{ key: 'spend', label: 'Spend', format: 'currencyCents' }]}
          size="sm"
        />
        <TrendChart
          title={`Daily leads · ${name}`}
          description="Last 30 days including today (the 30-day tile ends yesterday)"
          data={chartRows}
          series={[{ key: 'leads', label: 'Leads', format: 'number' }]}
          footnote={GLOSSARY.leads}
          size="sm"
        />
      </div>

      {data.account && <AccountCardView account={data.account} allTimeSpend={data.allTimeSpend} />}

      <Card>
        <CardContent>
          <p className="mb-3 text-sm font-semibold">What&apos;s in {name}</p>
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
