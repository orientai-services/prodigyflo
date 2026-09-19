import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { StepUpGate } from '@/components/stepup/stepup-gate'
import { DeployPanel } from './deploy-panel'

export const metadata = { title: 'Deploy' }

/**
 * Owner-only deploy console. Two-layer gate: isOwner here (redirect — there is
 * deliberately NO permission key that opens this page), then a fresh 'deploy'
 * step-up grant via <StepUpGate>. The gate is UX; every backing route under
 * /api/admin/deploy re-checks isOwner + requireStepUp itself.
 */
export default async function DeployPage() {
  const user = await requireUser()
  if (user.role !== 'SUPER_ADMIN') redirect('/forbidden')

  return (
    <>
      <PageHeader
        title="Deploy console"
        description="Ship the latest build to production and watch it land. Owner only — a recent password check is required."
      />
      <div className="space-y-4 p-4 sm:p-6">
        <StepUpGate scope="deploy">
          <DeployPanel />
        </StepUpGate>
      </div>
    </>
  )
}
