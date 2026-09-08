import Link from 'next/link'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Compass, Network, ExternalLink } from 'lucide-react'
import { requireUser } from '@/lib/rbac'
import { relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent } from '@/components/ui/card'

export const metadata = { title: 'Planning & progress' }

const REPORTS = [
  {
    slug: 'roadmap',
    icon: Compass,
    title: 'Roadmap',
    description:
      'Where the build stands against the development phases and priority levels — everything shipped at P0, what is next at P1, what is deferred, and the honest caveats to reflect on.',
  },
  {
    slug: 'schema-map',
    icon: Network,
    title: 'Schema map',
    description:
      'An interactive chord-ring of the database: every model on a ring of ten domains, relations as chords, live row counts, and the invariants that hold the schema together.',
  },
] as const

async function builtAt(slug: string): Promise<Date | null> {
  try {
    return (await stat(path.join(process.cwd(), 'reports', 'out', `${slug}.html`))).mtime
  } catch {
    return null
  }
}

export default async function ProgressPage() {
  await requireUser()
  const stamps = Object.fromEntries(
    await Promise.all(REPORTS.map(async (r) => [r.slug, await builtAt(r.slug)] as const)),
  )

  return (
    <div>
      <PageHeader
        title="Planning & progress"
        description="The project's status pages, generated from the codebase and live database — nothing on them is typed in by hand."
      />
      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
        {REPORTS.map((r) => {
          const built = stamps[r.slug]
          return (
            <Card key={r.slug}>
              <CardContent className="flex h-full flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="bg-brand-soft text-brand grid size-9 shrink-0 place-items-center rounded-lg">
                    <r.icon className="size-4.5" />
                  </div>
                  <div>
                    <h2 className="font-semibold">{r.title}</h2>
                    <p className="text-muted-foreground text-xs">
                      {built ? `updated ${relativeTime(built)}` : 'not built yet — run npm run reports'}
                    </p>
                  </div>
                </div>
                <p className="text-muted-foreground text-sm">{r.description}</p>
                <div className="mt-auto flex items-center gap-4 pt-1">
                  <Link
                    href={`/settings/progress/${r.slug}`}
                    className="text-brand text-sm font-medium underline-offset-4 hover:underline"
                  >
                    Open {r.title.toLowerCase()}
                  </Link>
                  <a
                    href={`/api/reports/${r.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                  >
                    full screen <ExternalLink className="size-3" />
                  </a>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
      <p className="text-muted-foreground px-4 pb-6 text-xs sm:px-6">
        Pages are rebuilt with <code className="bg-muted rounded px-1 py-0.5">npm run reports</code>,
        which measures models, relations, rows, routes and tests from the running system.
      </p>
    </div>
  )
}
