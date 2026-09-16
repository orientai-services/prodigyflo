import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Circle, Download } from 'lucide-react'
import { db } from '@/lib/db'
import { can, clientScope, requirePermissionPage } from '@/lib/rbac'
import { DeskChrome } from '@/components/desk/desk-chrome'
import { CysTab } from '@/components/client/cys-tab'
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
    <DeskChrome
      title={`${submission.destination} — ${fullName(submission.client)}`}
      description={`Attempt ${submission.attemptNumber}${submission.externalRef ? ` · ref ${submission.externalRef}` : ''}. Packet READY and CYS ready stay separate.`}
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
      <div className="desk-pills">
        <SubmissionStatusBadge status={submission.status} />
        <Link href="/submissions" className="desk-pill">
          <ArrowLeft className="size-3" />
          All packages
        </Link>
        <Link href={`/clients/${submission.client.id}`} className="desk-pill">
          Case file
        </Link>
        <a href={`/api/submissions/${submission.id}/package`} className="desk-pill">
          <Download className="size-3" />
          Download JSON
        </a>
      </div>

      <p className="desk-banner">
        No CYS API. The package is downloaded and handed over by a person; the buttons here only record what actually happened.
      </p>

      <div className="desk-g2">
        <section className="desk-card desk-block">
          <h3>Timeline</h3>
          <ul>
            {timeline.map((t) => (
              <li key={t.label} className="flex items-center justify-between gap-2" style={{ padding: '6px 0' }}>
                <span className={t.at ? '' : 'desk-muted'} style={{ marginBottom: 0 }}>
                  {t.label}
                </span>
                <span className="desk-muted" style={{ marginBottom: 0 }}>
                  {t.at ? dateTime(t.at) : '—'}
                </span>
              </li>
            ))}
          </ul>
          <p className="desk-muted">Approved by {submission.approvedBy?.name ?? '—'}</p>
          {submission.rejectionReason && (
            <p className="desk-v miss">Rejected: {submission.rejectionReason}</p>
          )}
        </section>

        <section className="desk-card desk-block">
          <h3>Validation report</h3>
          {report.completionPct === undefined ? (
            <p className="desk-muted">No validation report recorded.</p>
          ) : (
            <>
              <p>
                <b className="font-heading" style={{ fontSize: 28, fontWeight: 500 }}>
                  {report.completionPct}%
                </b>
                <span className="desk-muted" style={{ marginLeft: 8 }}>
                  required fields verified ({report.requiredVerified}/{report.requiredTotal})
                  {report.generatedAt ? ` · generated ${dateTime(report.generatedAt)}` : ''}
                </span>
              </p>
              {report.checklist && (
                <ul>
                  {report.checklist.map((item) => (
                    <li key={item.key} className="flex items-start gap-1.5" style={{ fontSize: 13, padding: '4px 0' }}>
                      {item.done ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--desk-green)' }} />
                      ) : (
                        <Circle className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--desk-muted)' }} />
                      )}
                      <span>{item.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>

      {corrections.length > 0 && (
        <section className="desk-card desk-block">
          <h3>Corrections requested</h3>
          <ul className="list-disc space-y-1 pl-5" style={{ fontSize: 13 }}>
            {corrections.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="desk-card desk-block">
        <h3>Package manifest ({manifest.length} documents)</h3>
        {manifest.length === 0 ? (
          <p className="desk-muted">No manifest recorded.</p>
        ) : (
          <div className="scroll-x">
            <table className="desk-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Type</th>
                  <th>Version</th>
                  <th>Checksum</th>
                </tr>
              </thead>
              <tbody>
                {manifest.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      {doc.name}
                      {doc.sizeBytes !== null && (
                        <div className="desk-muted" style={{ marginBottom: 0 }}>
                          {fileSize(doc.sizeBytes)} · {doc.mimeType ?? 'unknown type'}
                        </div>
                      )}
                    </td>
                    <td>{doc.type}</td>
                    <td>{doc.version}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{doc.checksum ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CysTab clientId={submission.client.id} />
    </DeskChrome>
  )
}
