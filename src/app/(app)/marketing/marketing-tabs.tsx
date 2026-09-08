import { SectionTabs } from '@/components/ui/section-tabs'

const TABS = [
  { key: 'overview', label: 'Overview', href: '/marketing' },
  { key: 'sources', label: 'Lead sources', href: '/marketing/sources' },
  { key: 'attribution', label: 'Attribution & forecast', href: '/marketing/analytics' },
  { key: 'meta', label: 'Meta Ads', href: '/marketing/meta' },
] as const

export type MarketingTabKey = (typeof TABS)[number]['key']

/** Section strip for the marketing perspective, mirroring RevopsTabs. */
export function MarketingTabs({ active }: { active: MarketingTabKey }) {
  return <SectionTabs tabs={TABS} active={active} aria-label="Marketing sections" />
}
