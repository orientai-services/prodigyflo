import { SectionTabs } from '@/components/ui/section-tabs'

const TABS = [
  { key: 'attribution', label: 'Attribution', href: '/marketing/analytics' },
  { key: 'forecast', label: 'Forecast', href: '/marketing/analytics/forecast' },
  { key: 'journey', label: 'Customer journey', href: '/marketing/analytics/journey' },
] as const

export type RevopsTabKey = (typeof TABS)[number]['key']

export function RevopsTabs({ active }: { active: RevopsTabKey }) {
  return <SectionTabs tabs={TABS} active={active} aria-label="Revenue analytics sections" />
}
