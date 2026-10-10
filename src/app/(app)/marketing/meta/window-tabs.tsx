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

/** The page the dashboard lives on. Call Center embeds it under `?tab=ads`. */
export const META_ADS_PATH = '/marketing/meta'

export function metaHref(
  params: { view?: AdsView; w?: AdsWindow; range?: FunnelRange },
  base: string = META_ADS_PATH,
): string {
  const q = new URLSearchParams()
  if (params.view && params.view !== 'overview') q.set('view', params.view)
  if (params.w && params.w !== '30d') q.set('w', params.w)
  if (params.range && params.range !== '30d') q.set('range', params.range)
  const s = q.toString()
  if (!s) return base
  return `${base}${base.includes('?') ? '&' : '?'}${s}`
}

export function ViewTabs({ active, canManage, w, base }: { active: AdsView; canManage: boolean; w: AdsWindow; base?: string }) {
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
        href: metaHref({ view: t.key, w: t.key === 'overview' || t.key === 'ads' ? w : undefined }, base),
      }))}
    />
  )
}

export function WindowTabs({ view, active, base }: { view: 'overview' | 'ads'; active: AdsWindow; base?: string }) {
  return (
    <SectionTabs
      aria-label="Time period"
      className="mt-0"
      active={active}
      tabs={WINDOWS.map((w) => ({ key: w.key, label: w.label, href: metaHref({ view, w: w.key }, base) }))}
    />
  )
}

export function RangeTabs({ active, base }: { active: FunnelRange; base?: string }) {
  return (
    <SectionTabs
      aria-label="Funnel period"
      className="mt-0"
      active={active}
      tabs={RANGES.map((r) => ({ key: r.key, label: r.label, href: metaHref({ view: 'funnel', range: r.key }, base) }))}
    />
  )
}
