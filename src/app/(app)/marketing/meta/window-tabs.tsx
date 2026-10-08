import { SectionTabs } from '@/components/ui/section-tabs'
import type { AdsWindow, FunnelRange } from '@/lib/meta/ads/read'

/**
 * Link-based pickers for the Meta Ads page. State lives in the URL, so every
 * pick is a real navigation and the server renders from the database only.
 */

export type AdsView = 'overview' | 'ads' | 'funnel' | 'cycle' | 'billing' | 'connection'

const WINDOWS: { key: AdsWindow; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'max', label: 'All time' },
]

const RANGES: { key: FunnelRange; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
]

export function metaHref(params: { view?: AdsView; w?: AdsWindow; range?: FunnelRange }): string {
  const q = new URLSearchParams()
  if (params.view && params.view !== 'overview') q.set('view', params.view)
  if (params.w && params.w !== '30d') q.set('w', params.w)
  if (params.range && params.range !== '30d') q.set('range', params.range)
  const s = q.toString()
  return s ? `/marketing/meta?${s}` : '/marketing/meta'
}

export function ViewTabs({ active, canManage, w }: { active: AdsView; canManage: boolean; w: AdsWindow }) {
  const tabs: { key: AdsView; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'ads', label: 'Ads' },
    { key: 'funnel', label: 'Funnel' },
    { key: 'cycle', label: 'Cycle' },
    ...(canManage
      ? [
          { key: 'billing' as const, label: 'Billing' },
          { key: 'connection' as const, label: 'Connection' },
        ]
      : []),
  ]
  return (
    <SectionTabs
      aria-label="Meta Ads views"
      className="mt-0"
      active={active}
      tabs={tabs.map((t) => ({
        key: t.key,
        label: t.label,
        // Keep the chosen window when moving between the two views that use it.
        href: metaHref({ view: t.key, w: t.key === 'overview' || t.key === 'ads' ? w : undefined }),
      }))}
    />
  )
}

export function WindowTabs({ view, active }: { view: 'overview' | 'ads'; active: AdsWindow }) {
  return (
    <SectionTabs
      aria-label="Time period"
      className="mt-0"
      active={active}
      tabs={WINDOWS.map((w) => ({ key: w.key, label: w.label, href: metaHref({ view, w: w.key }) }))}
    />
  )
}

export function RangeTabs({ active }: { active: FunnelRange }) {
  return (
    <SectionTabs
      aria-label="Funnel period"
      className="mt-0"
      active={active}
      tabs={RANGES.map((r) => ({ key: r.key, label: r.label, href: metaHref({ view: 'funnel', range: r.key }) }))}
    />
  )
}
