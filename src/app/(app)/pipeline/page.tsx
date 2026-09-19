import { requireUser } from '@/lib/rbac'
import { redirect } from 'next/navigation'
import { PipelineBoard } from '../board/pipeline-board'

export const metadata = { title: 'Pipeline' }

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  if (user.role !== 'SUPER_ADMIN') redirect('/forbidden')
  return <PipelineBoard searchParams={searchParams} title="Pipeline" />
}
