import { finalDeskEnabled } from '@/lib/final-desk/data'
import { FinalDeskPage } from '@/components/final-desk/page'
import Link from 'next/link'
import type { Prisma, SubmissionStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, requirePermissionPage } from '@/lib/rbac'
import { DeskChrome } from '@/components/desk/desk-chrome'
import { fullName, humanize, relativeTime, shortDate } from '@/lib/format'
import { SubmissionStatusBadge } from './status'

export const metadata = { title: 'CYS' }

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
  if (finalDeskEnabled()) return <FinalDeskPage view="submissions" />
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
    <DeskChrome
      title="CYS"
      description={`${total.toLocaleString()} package${total === 1 ? '' : 's'} tracked. generateCysPackage is a JSON draft only — no HTTP push. Packet READY and CYS ready stay two gates.`}
    >
      <div className="desk-pills">
        <Link href="/submissions" className={`desk-pill${!status ? ' on' : ''}`}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/submissions?status=${s}`}
            className={`desk-pill${status === s ? ' on' : ''}`}
          >
            {humanize(s)}
          </Link>
        ))}
      </div>

      <section className="desk-card desk-block">
        <p className="desk-banner" style={{ marginBottom: 14 }}>
          No CYS API connection. Packages are generated from an approved client, downloaded, and delivered by a person. Statuses here are recorded after the fact.
        </p>
        {submissions.length === 0 ? (
          <p className="desk-empty">
            {status
              ? `No ${humanize(status).toLowerCase()} submissions.`
              : 'No submissions yet. Generate a CYS package from an approved client to start tracking.'}
          </p>
        ) : (
          <div className="scroll-x">
            <table className="desk-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Attempt</th>
                  <th>External ref</th>
                  <th>Approved by</th>
                  <th>Submitted</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/submissions/${s.id}`}>{fullName(s.client)}</Link>
                    </td>
                    <td>{s.destination}</td>
                    <td>
                      <SubmissionStatusBadge status={s.status} />
                    </td>
                    <td>{s.attemptNumber}</td>
                    <td>{s.externalRef ?? '—'}</td>
                    <td>{s.approvedBy?.name ?? '—'}</td>
                    <td>{shortDate(s.submittedAt)}</td>
                    <td>{relativeTime(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </DeskChrome>
  )
}
