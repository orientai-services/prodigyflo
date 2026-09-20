import { notFound } from 'next/navigation'
import { finalDeskEnabled } from '@/lib/final-desk/data'
import { FinalDeskPage } from '@/components/final-desk/page'
export default async function QuestionnairePage({ params }: { params: Promise<{ clientId: string }> }) {
  if (!finalDeskEnabled()) notFound()
  const { clientId } = await params
  return <FinalDeskPage view="questionnaire" clientId={clientId} />
}
