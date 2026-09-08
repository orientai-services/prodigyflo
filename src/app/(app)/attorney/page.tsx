import Link from 'next/link'
import { Info } from 'lucide-react'
import { requirePermissionPage } from '@/lib/rbac'
import { getAttorneyQueue } from '@/lib/attorney'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { fullName, relativeTime } from '@/lib/format'
import { SubmissionStatusBadge } from '../submissions/status'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Attorney review' }

export default async function AttorneyQueuePage() {
  const user = await requirePermissionPage('submissions:prepare')
  const queue = await getAttorneyQueue(user)

  const ready = queue.filter((r) => r.readiness.ready).length

  return (
    <>
      <PageHeader
        title="Attorney review"
        description={`${queue.length.toLocaleString()} client${queue.length === 1 ? '' : 's'} in the attorney workflow · ${ready} ready to approve. A client is ready when every attorney-required document is approved and a signed contract is on file.`}
      />

      <div className="p-4 sm:p-6">
        <Alert>
          <Info />
          <AlertTitle>Delivery to the attorney is manual</AlertTitle>
          <AlertDescription>
            Approving a client here freezes the reviewed documents into a draft package. A person
            hands it over and records the delivery under Submissions — nothing is sent
            automatically.
          </AlertDescription>
        </Alert>
      </div>

      {queue.length === 0 ? (
        <EmptyState
          icon="Scale"
          title="No clients in attorney review"
          description="Clients appear here once they reach the attorney document review stage or have attorney-required documents requested."
        />
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[56rem] text-sm tabular-nums">
            <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
              <tr className="border-y">
                <th className="px-4 py-2 text-left">Client</th>
                <th className="px-4 py-2 text-left">Stage</th>
                <th className="px-4 py-2 text-left">Attorney documents</th>
                <th className="px-4 py-2 text-left">Signed contract</th>
                <th className="px-4 py-2 text-left">Readiness</th>
                <th className="px-4 py-2 text-left">Attorney package</th>
                <th className="px-4 py-2 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {queue.map(({ client, readiness, latestSubmission }) => (
                <tr key={client.id} className="hover:bg-muted/40 border-b transition-colors">
                  <td className="px-4 py-2.5">
                    <Link href={`/attorney/${client.id}`} className="font-medium">
                      {fullName(client)}
                    </Link>
                    {client.owner?.name && (
                      <p className="text-muted-foreground text-xs">{client.owner.name}</p>
                    )}
                  </td>
                  <td className="text-muted-foreground px-4 py-2.5 text-xs">
                    {client.currentStage.name}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'tabular-nums',
                        readiness.requiredTotal > 0 &&
                          readiness.requiredApproved === readiness.requiredTotal
                          ? 'text-success'
                          : 'text-muted-foreground',
                      )}
                    >
                      {readiness.requiredApproved}/{readiness.requiredTotal} approved
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {readiness.hasSignedContract ? (
                      <Badge variant="outline" className="border-transparent bg-success/10 text-success">
                        On file
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-transparent bg-warning/10 text-warning">
                        Missing
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {readiness.ready ? (
                      <Badge variant="outline" className="border-transparent bg-success/10 text-success">
                        Ready to approve
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-muted text-muted-foreground border-transparent">
                        {readiness.blockers.length} blocker{readiness.blockers.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {latestSubmission ? (
                      <Link href={`/submissions/${latestSubmission.id}`} className="inline-flex items-center gap-1.5">
                        <SubmissionStatusBadge status={latestSubmission.status} />
                        <span className="text-muted-foreground text-xs">
                          attempt {latestSubmission.attemptNumber}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground text-xs">Not started</span>
                    )}
                  </td>
                  <td className="text-muted-foreground px-4 py-2.5 text-right text-xs whitespace-nowrap">
                    {relativeTime(client.updatedAt)}
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
