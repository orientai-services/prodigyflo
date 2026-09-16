import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { DuplicateBanner } from '@/components/client/duplicate-banner'
import { loadCaseFile } from '@/lib/daily-desk-case'
import { CaseFileView } from './case-file-client'
import { CloserBriefSection } from './closeops-section'

export const metadata = { title: 'Client' }

export default async function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireUser()
  const { clientId } = await params
  const data = await loadCaseFile(user, clientId)
  if (!data) notFound()

  return (
    <>
      <DuplicateBanner clientId={clientId} />
      <CaseFileView data={data}>{data.canBrief ? <CloserBriefSection clientId={clientId} /> : null}</CaseFileView>
    </>
  )
}
