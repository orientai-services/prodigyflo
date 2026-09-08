import Link from 'next/link'
import { Info } from 'lucide-react'
import type { Prisma, SubmissionStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { fullName, humanize, relativeTime, shortDate } from '@/lib/format'
import { SubmissionStatusBadge } from './status'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Submissions' }

const STATUSES: SubmissionStatus[] = [
  'DRAFT',
  'READY',
  'SUBMITTED',
  'ACKNOWLEDGED',
  'CORRECTIONS_REQUESTED',
  'RESUBMITTED',
  'APPROVED',
  'REJECTED',
]

export default async function SubmissionsPage({ searchParams }: PageProps<'/submissions'>) {
  const user = await requirePermissionPage('submissions:read')
  const params = await searchParams
  const statusParam = typeof params.status === 'string' ? params.status : undefined
  const status = STATUSES.includes(statusParam as SubmissionStatus)
    ? (statusParam as SubmissionStatus)
    : undefined

  const where: Prisma.SubmissionWhereInput = {
    client: clientScope(user),
    ...(status ? { status } : {}),
  }

  const [submissions, total] = await Promise.all([
    db.submission.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: {
        client: { select: { id: true, firstName: true, lastName: true } },
        approvedBy: { select: { name: true } },
      },
    }),
    db.submission.count({ where }),
  ])

  return (
    <>
      <PageHeader
        title="Submissions"
        description={`${total.toLocaleString()} package${total === 1 ? '' : 's'} tracked. Delivery to CYS is manual — this list records what staff actually handed over.`}
      >
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Link
            href="/submissions"
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs',
              !status ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            All
          </Link>
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={`/submissions?status=${s}`}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs',
                status === s ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {humanize(s)}
            </Link>
          ))}
        </div>
      </PageHeader>

      <div className="p-4 sm:p-6">
        <Alert>
          <Info />
          <AlertTitle>No CYS API connection</AlertTitle>
          <AlertDescription>
            Packages are generated from an approved client, downloaded, and delivered by a person.
            Statuses here are recorded manually after the fact.
          </AlertDescription>
        </Alert>
      </div>

      {submissions.length === 0 ? (
        <EmptyState
          icon="Send"
          title={status ? `No ${humanize(status).toLowerCase()} submissions` : 'No submissions yet'}
          description="Generate a CYS package from an approved client to start tracking a submission."
        />
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[56rem] text-sm tabular-nums">
            <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              <tr className="border-y">
                <th className="px-4 py-2 text-left">Client</th>
                <th className="px-4 py-2 text-left">Destination</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Attempt</th>
                <th className="px-4 py-2 text-left">External ref</th>
                <th className="px-4 py-2 text-left">Approved by</th>
                <th className="px-4 py-2 text-left">Submitted</th>
                <th className="px-4 py-2 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} className="hover:bg-muted/40 border-b transition-colors">
                  <td className="px-4 py-2.5">
                    <Link href={`/submissions/${s.id}`} className="font-medium">
                      {fullName(s.client)}
                    </Link>
                  </td>
                  <td className="text-muted-foreground px-4 py-2.5 text-xs">{s.destination}</td>
                  <td className="px-4 py-2.5">
                    <SubmissionStatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{s.attemptNumber}</td>
                  <td className="text-muted-foreground px-4 py-2.5 text-xs">{s.externalRef ?? '—'}</td>
                  <td className="text-muted-foreground px-4 py-2.5 text-xs">
                    {s.approvedBy?.name ?? '—'}
                  </td>
                  <td className="text-muted-foreground px-4 py-2.5 text-xs">
                    {shortDate(s.submittedAt)}
                  </td>
                  <td className="text-muted-foreground px-4 py-2.5 text-right text-xs whitespace-nowrap">
                    {relativeTime(s.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
