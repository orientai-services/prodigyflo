import { PipelineBoard } from '../board/pipeline-board'

export const metadata = { title: 'Pipeline' }

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return <PipelineBoard searchParams={searchParams} title="Pipeline" />
}
