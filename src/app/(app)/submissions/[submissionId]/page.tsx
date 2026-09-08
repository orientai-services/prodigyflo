import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Circle, Download, Info } from 'lucide-react'
import { db } from '@/lib/db'
import { can, clientScope, requirePermissionPage } from '@/lib/rbac'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { dateTime, fileSize, fullName } from '@/lib/format'
import { SubmissionStatusBadge } from '../status'
import {
  MarkResubmittedDialog,
  MarkSubmittedDialog,
  RecordCorrectionsDialog,
} from '../submission-status-actions'

export const metadata = { title: 'Submission' }

type ValidationReport = {
  generatedAt?: string
  completionPct?: number
  requiredTotal?: number
  requiredVerified?: number
  checklist?: { key: string; label: string; done: boolean }[]
}

type ManifestDoc = {
  id: string
  name: string
  type: string
  mimeType: string | null
  sizeBytes: number | null
  checksum: string | null
  version: number
  status: string
}

export default async function SubmissionDetailPage({
  params,
}: PageProps<'/submissions/[submissionId]'>) {
  const user = await requirePermissionPage('submissions:read')
  const { submissionId } = await params

  const submission = await db.submission.findFirst({
    where: { id: submissionId, client: clientScope(user) },
    include: {
      client: { select: { id: true, firstName: true, lastName: true, email: true } },
      approvedBy: { select: { name: true } },
    },
  })
  if (!submission) notFound()

  const canPrepare = can(user, 'submissions:prepare')
  const report = (submission.validationReport ?? {}) as ValidationReport
  const manifest = (Array.isArray(submission.packageManifest)
    ? submission.packageManifest
    : []) as ManifestDoc[]
  const corrections = (Array.isArray(submission.correctionsRequested)
    ? submission.correctionsRequested
    : []) as string[]

  const timeline: { label: string; at: Date | null }[] = [
    { label: 'Created', at: submission.createdAt },
    { label: 'Approved', at: submission.approvedAt },
    { label: 'Submitted', at: submission.submittedAt },
    { label: 'Acknowledged', at: submission.acknowledgedAt },
    { label: 'Corrections requested', at: submission.correctionsRequestedAt },
    { label: 'Resubmitted', at: submission.resubmittedAt },
  ]

  return (
    <>
      <PageHeader
        title={`${submission.destination} submission — ${fullName(submission.client)}`}
        description={`Attempt ${submission.attemptNumber}${submission.externalRef ? ` · ref ${submission.externalRef}` : ''}`}
        actions={
          <>
            {canPrepare && (submission.status === 'DRAFT' || submission.status === 'READY') && (
              <MarkSubmittedDialog submissionId={submission.id} />
            )}
            {canPrepare &&
              ['SUBMITTED', 'ACKNOWLEDGED', 'RESUBMITTED'].includes(submission.status) && (
                <RecordCorrectionsDialog submissionId={submission.id} />
              )}
            {canPrepare && submission.status === 'CORRECTIONS_REQUESTED' && (
              <MarkResubmittedDialog submissionId={submission.id} />
            )}
          </>
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <SubmissionStatusBadge status={submission.status} />
          <Link
            href="/submissions"
            className="text-muted-foreground inline-flex items-center gap-1 text-xs hover:underline"
          >
            <ArrowLeft className="size-3" />
            All submissions
          </Link>
          <Link
            href={`/clients/${submission.client.id}`}
            className="text-primary text-xs underline underline-offset-4"
          >
            Open client record
          </Link>
          <a
            href={`/api/cys/${submission.client.id}/package`}
            className="text-primary inline-flex items-center gap-1 text-xs underline underline-offset-4"
          >
            <Download className="size-3" />
            Download package
          </a>
        </div>
      </PageHeader>

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Alert>
            <Info />
            <AlertTitle>Manual delivery</AlertTitle>
            <AlertDescription>
              No CYS API exists. The package is downloaded and handed over by a person; the buttons
              here only record what actually happened.
            </AlertDescription>
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {timeline.map((t) => (
                  <li key={t.label} className="flex items-center justify-between gap-2 text-sm">
                    <span className={t.at ? '' : 'text-muted-foreground'}>{t.label}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {t.at ? dateTime(t.at) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Approved by {submission.approvedBy?.name ?? '—'}
              </p>
              {submission.rejectionReason && (
                <p className="text-destructive mt-2 text-xs">Rejected: {submission.rejectionReason}</p>
              )}
            </CardContent>
          </Card>

          {corrections.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Corrections requested</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {corrections.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Validation report</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.completionPct === undefined ? (
                <p className="text-muted-foreground text-sm">No validation report recorded.</p>
              ) : (
                <>
                  <p className="text-sm">
                    <span className="text-2xl font-semibold tabular-nums">{report.completionPct}%</span>{' '}
                    <span className="text-muted-foreground text-xs">
                      required fields verified ({report.requiredVerified}/{report.requiredTotal})
                      {report.generatedAt ? ` · generated ${dateTime(report.generatedAt)}` : ''}
                    </span>
                  </p>
                  {report.checklist && (
                    <ul className="space-y-1">
                      {report.checklist.map((item) => (
                        <li key={item.key} className="flex items-start gap-1.5 text-xs">
                          {item.done ? (
                            <CheckCircle2 className="text-success mt-0.5 size-3.5 shrink-0" />
                          ) : (
                            <Circle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                          )}
                          <span>{item.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Package manifest ({manifest.length} documents)</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {manifest.length === 0 ? (
                <p className="text-muted-foreground px-6 text-sm">No manifest recorded.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-sm tabular-nums">
                    <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                      <tr className="border-y">
                        <th className="px-4 py-2 text-left">Document</th>
                        <th className="px-4 py-2 text-left">Type</th>
                        <th className="px-4 py-2 text-right">Version</th>
                        <th className="px-4 py-2 text-left">Checksum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manifest.map((doc) => (
                        <tr key={doc.id} className="border-b last:border-0">
                          <td className="px-4 py-2">
                            {doc.name}
                            {doc.sizeBytes !== null && (
                              <span className="text-muted-foreground block text-xs">
                                {fileSize(doc.sizeBytes)} · {doc.mimeType ?? 'unknown type'}
                              </span>
                            )}
                          </td>
                          <td className="text-muted-foreground px-4 py-2 text-xs">{doc.type}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{doc.version}</td>
                          <td className="text-muted-foreground max-w-[10rem] truncate px-4 py-2 font-mono text-xs">
                            {doc.checksum ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
