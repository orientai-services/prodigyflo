import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { can, requirePermissionPage } from '@/lib/rbac'
import { finalDeskEnabled } from '@/lib/final-desk/data'
import { PageHeader } from '@/components/page-header'
import { buttonVariants } from '@/components/ui/button'
import { MarketingTabs } from '../marketing-tabs'
import { RefreshButton } from './refresh-button'
import { AdsStatusLine, MetaAdsContent, loadAdsContent } from './dashboard'

export const metadata = { title: 'Meta Ads' }

/** "Refresh now" runs a full sync inside its server action; give it the cron's budget. */
export const maxDuration = 300

/**
 * The Meta Ads page on its own. Under the final desk the same dashboard lives
 * inside Call Center (`/call-center?tab=ads`), and this page keeps working as
 * a deep link with a way back.
 */
export default async function MetaAdsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePermissionPage('connectors:read')
  const canManage = can(user, 'connectors:manage')
  const finalDesk = finalDeskEnabled()
  const params = await searchParams
  const loaded = await loadAdsContent(user, params)
  const { dashboard } = loaded
  const account = dashboard?.account ?? null
  const sync = dashboard?.sync ?? null

  return (
    <div>
      <PageHeader
        title="Meta Ads"
        description={account ? `${account.name} · ${account.adAccountId}` : 'Facebook and Instagram ads'}
        actions={
          finalDesk || (canManage && sync && sync.mode !== 'not_connected') ? (
            <>
              {finalDesk && (
                <Link href="/call-center?tab=ads" className={buttonVariants({ variant: 'ghost', className: 'h-10 sm:h-8' })}>
                  <ArrowLeft data-icon="inline-start" /> Back to Call Center
                </Link>
              )}
              {canManage && sync && sync.mode !== 'not_connected' && <RefreshButton />}
            </>
          ) : undefined
        }
      >
        {sync && (
          <div className="mt-3">
            <AdsStatusLine dashboard={dashboard} canManage={canManage} embedded={false} />
          </div>
        )}
        {!finalDesk && <MarketingTabs active="meta" />}
      </PageHeader>
      <div className="space-y-4 p-4 sm:p-6">
        <MetaAdsContent user={user} params={params} />
      </div>
    </div>
  )
}
