import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { requireUser } from '@/lib/rbac'

export const metadata = { title: 'Planning & progress' }

const TITLES: Record<string, string> = {
  roadmap: 'Roadmap',
  'schema-map': 'Schema map',
}

export default async function ReportViewerPage({
  params,
}: {
  params: Promise<{ report: string }>
}) {
  await requireUser()
  const { report } = await params
  const title = TITLES[report]
  if (!title) notFound()

  return (
    // The report is a standalone document with its own chrome, so the viewer is
    // a thin frame: a slim bar to get back, then the page at full height.
    <div className="flex h-[calc(100dvh)] flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2 text-sm">
        <Link
          href="/settings/progress"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="size-3.5" /> Planning &amp; progress
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-medium">{title}</span>
        <a
          href={`/api/reports/${report}`}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
        >
          open full screen <ExternalLink className="size-3" />
        </a>
      </div>
      <iframe
        src={`/api/reports/${report}`}
        title={title}
        className="w-full flex-1 border-0"
      />
    </div>
  )
}
