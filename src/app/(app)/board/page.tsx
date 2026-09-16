import Link from 'next/link'
import { PipelineBoard } from './pipeline-board'

export const metadata = { title: 'Board' }

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <PipelineBoard
      searchParams={searchParams}
      title="Board"
      notice={
        <p className="text-muted-foreground px-4 sm:px-6 -mt-2 mb-4 text-sm">
          Pipeline kanban also lives at{' '}
          <Link href="/pipeline" className="text-foreground underline-offset-4 hover:underline">
            /pipeline
          </Link>
          . This page stays the kanban until the Daily Desk calendar lands.
        </p>
      }
    />
  )
}
