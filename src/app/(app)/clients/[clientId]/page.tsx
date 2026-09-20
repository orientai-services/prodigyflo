import { finalDeskEnabled } from '@/lib/final-desk/data'
import { FinalDeskPage } from '@/components/final-desk/page'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { DuplicateBanner } from '@/components/client/duplicate-banner'
import { loadCaseFile } from '@/lib/daily-desk-case'
import { CaseFileView } from './case-file-client'
import { CysTab } from '@/components/client/cys-tab'
import { CloserBriefSection } from './closeops-section'

export const metadata = { title: 'Client' }

export default async function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireUser()
  const { clientId } = await params
  if (finalDeskEnabled()) return <FinalDeskPage view="profile" clientId={clientId} />
  const data = await loadCaseFile(user, clientId)
  if (!data) notFound()

  return (
    <>
      <DuplicateBanner clientId={clientId} />
      <CaseFileView data={data} cys={<CysTab clientId={clientId} />}>{data.canBrief ? <CloserBriefSection clientId={clientId} /> : null}</CaseFileView>
    </>
  )
}
