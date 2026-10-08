import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import type { AdsDashboard } from '@/lib/meta/ads/read'
import { WindowTabs } from '../window-tabs'
import { CampaignTable } from '../campaign-table'
import { count } from './parts'

export function AdsTreeView({ data, selectedId }: { data: AdsDashboard; selectedId?: string }) {
  const campaigns = data.tree.filter((r) => r.kind === 'campaign').length

  return (
    <div className="space-y-4">
      <WindowTabs view="ads" active={data.window} />
      {campaigns === 0 ? (
        <Card>
          <EmptyState
            icon="Megaphone"
            title="No campaigns yet"
            description="Campaigns appear here after the first sync with Meta finds them."
          />
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {count(data.counts.campaigns)} campaigns · {count(data.counts.adSets)} ad sets · {count(data.counts.ads)} ads (
            {count(data.counts.activeAds)} running). Open a campaign to see its ad sets and ads, and tap an ad to see what
            people see.
          </p>
          <CampaignTable
            tree={data.tree}
            writesEnabled={data.writesEnabled}
            canManage={data.canManage}
            selectedId={selectedId}
          />
        </>
      )}
    </div>
  )
}
