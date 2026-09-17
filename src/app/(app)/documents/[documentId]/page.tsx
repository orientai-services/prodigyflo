import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Download } from 'lucide-react'
import { db } from '@/lib/db'
import { requirePermissionPage } from '@/lib/rbac'
import { documentScope } from '@/lib/storage/access'
import { signedDocumentFileUrl } from '@/lib/storage'
import {
  BULK_VERIFY_THRESHOLD,
  canApproveDocument,
  specForType,
  type ReviewableField,
} from '@/lib/extraction/spec'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DeskChrome } from '@/components/desk/desk-chrome'
import { Separator } from '@/components/ui/separator'
import { dateTime, fileSize, fullName, humanize, relativeTime } from '@/lib/format'
import { DocumentActions } from '../document-actions'
import { FieldActions } from '../field-actions'
import { ConfidenceMeter, DocumentStatusBadge, ProviderBadge, VerificationBadge } from '../status-badge'
import { UploadButton } from '../upload-button'

export const metadata = { title: 'Review document' }

export default async function DocumentReviewPage({ params }: PageProps<'/documents/[documentId]'>) {
  const user = await requirePermissionPage('documents:review')
  const { documentId } = await params

  const doc = await db.clientDocument.findFirst({
    where: { AND: [documentScope(user), { id: documentId }] },
    include: {
      client: { select: { id: true, firstName: true, lastName: true, email: true } },
      requirement: { select: { id: true, name: true, key: true, isRequired: true } },
      collector: { select: { name: true } },
      reviews: { include: { reviewer: { select: { name: true } } }, orderBy: { reviewedAt: 'desc' } },
      extractions: {
        orderBy: { createdAt: 'desc' },
        include: { fields: { include: { verifiedBy: { select: { name: true } } } } },
      },
    },
  })
  if (!doc) redirect('/forbidden')

  const extraction = doc.extractions.find((e) => e.status === 'COMPLETED') ?? doc.extractions[0] ?? null
  const spec = specForType(extraction?.detectedTypeKey)
  const specOrder = new Map(spec.fields.map((f, i) => [f.key, i]))
  const fields = [...(extraction?.fields ?? [])].sort(
    (a, b) => (specOrder.get(a.key) ?? 99) - (specOrder.get(b.key) ?? 99),
  )

  const approval = extraction
    ? canApproveDocument(spec, fields as ReviewableField[])
    : { ok: false, blocking: [{ key: '_', label: 'Extraction', reason: 'has not completed' }] }
  const bulkEligible = fields.filter(
    (f) => f.verification === 'UNVERIFIED' && f.confidence >= BULK_VERIFY_THRESHOLD && f.value?.trim() && !f.conflictNote,
  ).length

  const fileUrl = await signedDocumentFileUrl(doc)
  const downloadUrl = await signedDocumentFileUrl(doc, { download: true })

  const versions = doc.requirementId
    ? await db.clientDocument.findMany({
        where: { clientId: doc.clientId, requirementId: doc.requirementId },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, status: true, fileName: true, receivedAt: true, requestedAt: true },
      })
    : [{ id: doc.id, version: doc.version, status: doc.status, fileName: doc.fileName, receivedAt: doc.receivedAt, requestedAt: doc.requestedAt }]

  const requiredKeys = new Set(spec.fields.filter((f) => f.required).map((f) => f.key))
  const finished = doc.status === 'APPROVED' || doc.status === 'REJECTED' || doc.status === 'EXPIRED'

  const title = doc.label ?? doc.requirement?.name ?? doc.fileName ?? 'Document'

  return (
    <DeskChrome
      title={title}
      description={`${fullName(doc.client)}${doc.requirement ? ` · ${doc.requirement.name}` : ''}${extraction?.detectedTypeLabel ? ` · detected as ${extraction.detectedTypeLabel}` : ''}${doc.collector ? ` · collector: ${doc.collector.name}` : ''}`}
      actions={
        <DocumentActions
          documentId={doc.id}
          canApprove={approval.ok && !finished && Boolean(extraction)}
          blocking={approval.blocking.map((b) => `${b.label} ${b.reason}`)}
          bulkEligibleCount={finished ? 0 : bulkEligible}
          showRerun={Boolean(doc.storageKey)}
          finished={finished}
        />
      }
    >
      <div className="desk-pills">
        <Link href="/documents" className="desk-pill">
          <ArrowLeft className="size-3" />
          Review queue
        </Link>
        <Link href={`/clients/${doc.client.id}`} className="desk-pill">
          Case file
        </Link>
        <span className="desk-tag">v{doc.version}</span>
        <DocumentStatusBadge status={doc.status} />
        {extraction && <ProviderBadge provider={extraction.provider} model={extraction.model} />}
      </div>
      {doc.rejectionReason && <p className="desk-banner">Rejection reason: {doc.rejectionReason}</p>}

      <div className="desk-g2">
        <section className="desk-card desk-block">
          <div className="desk-cal-head" style={{ padding: 0 }}>
            <h3>Quick look</h3>
            {downloadUrl && (
              <a href={downloadUrl} className="desk-btn-secondary">
                <Download className="size-3.5" />
                Download
              </a>
            )}
          </div>
          {!doc.storageKey || !fileUrl ? (
            <div className="desk-empty-look">
              <div className="desk-v miss" style={{ fontSize: 20 }}>
                Not on file
              </div>
              <p className="desk-muted">This document is not uploaded yet. No preview is invented.</p>
            </div>
          ) : (
            <div className="desk-paper">
              {doc.mimeType?.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl} alt={doc.fileName ?? title} />
              ) : (
                <iframe title={doc.fileName ?? title} src={fileUrl} />
              )}
            </div>
          )}
          <p className="desk-muted" style={{ marginTop: 10 }}>
            {doc.fileName} · {doc.mimeType} · {fileSize(doc.sizeBytes)}
            {doc.checksum && <> · sha256 {doc.checksum.slice(0, 12)}…</>}
          </p>
        </section>

        {/* Extracted fields */}
        <div className="flex flex-col gap-4">
          {extraction?.warnings && (extraction.warnings as string[]).length > 0 && (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>Extraction notes</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {(extraction.warnings as string[]).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <section className="desk-card desk-block">
            <h3>
              Extracted fields
              {extraction?.summary && (
                <span className="desk-muted" style={{ display: 'block', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                  {extraction.summary}
                </span>
              )}
            </h3>
            {!extraction ? (
              <p className="desk-muted">No extraction has run for this document.</p>
            ) : extraction.status === 'FAILED' ? (
              <p className="desk-v miss">Extraction failed: {extraction.error}</p>
            ) : fields.length === 0 ? (
              <p className="desk-muted">No field specification applies to this document type — approve or reject it on sight.</p>
            ) : (
              <ul>
                {fields.map((field) => {
                  const effective = field.correctedValue?.trim() ? field.correctedValue : field.value
                  const missing = (extraction.missingFieldKeys ?? []).includes(field.key)
                  return (
                    <li key={field.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--desk-line)' }}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p style={{ fontSize: 12, fontWeight: 600 }}>
                            {field.label}
                            {requiredKeys.has(field.key) && <span className="desk-v miss"> *</span>}
                          </p>
                          <p style={{ marginTop: 2 }}>
                            {effective ? (
                              <span className={field.verification === 'REJECTED' ? 'line-through opacity-60' : ''}>
                                {effective}
                              </span>
                            ) : (
                              <span className="desk-muted">not extracted</span>
                            )}
                            {field.correctedValue?.trim() && field.value && field.correctedValue !== field.value && (
                              <span className="desk-muted" style={{ marginLeft: 8, textDecoration: 'line-through' }}>
                                {field.value}
                              </span>
                            )}
                          </p>
                        </div>
                        {!finished && (
                          <FieldActions
                            fieldId={field.id}
                            label={field.label}
                            value={field.value}
                            hasValue={Boolean(field.value?.trim() || field.correctedValue?.trim())}
                          />
                        )}
                      </div>
                      <div className="desk-muted" style={{ marginTop: 6, marginBottom: 0 }}>
                        <ConfidenceMeter value={field.confidence} />
                        <VerificationBadge verification={field.verification} />
                        {field.sourcePage && <span> p. {field.sourcePage}</span>}
                        {missing && field.verification === 'UNVERIFIED' && <span> · missing / below confidence floor</span>}
                        {field.verifiedBy && field.verifiedAt && (
                          <span>
                            {' '}
                            · {humanize(field.verification)} by {field.verifiedBy.name} {relativeTime(field.verifiedAt)}
                          </span>
                        )}
                      </div>
                      {field.sourceSnippet && (
                        <p className="desk-muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }} title={field.sourceSnippet}>
                          “{field.sourceSnippet}”
                        </p>
                      )}
                      {field.conflictNote && (
                        <p className="desk-v miss" style={{ fontSize: 12 }}>
                          <AlertTriangle className="mr-1 inline size-3 align-[-2px]" />
                          {field.conflictNote}
                        </p>
                      )}
                      {field.reviewerNote && <p className="desk-muted">Reviewer note: {field.reviewerNote}</p>}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="desk-card desk-block">
            <h3>Versions</h3>
            <ul>
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2" style={{ padding: '8px 0', borderBottom: '1px solid var(--desk-line)' }}>
                  <span>
                    {v.id === doc.id ? (
                      <b>v{v.version}</b>
                    ) : (
                      <Link href={`/documents/${v.id}`}>v{v.version}</Link>
                    )}
                    <span className="desk-muted" style={{ marginLeft: 8 }}>
                      {v.fileName ?? 'awaiting upload'}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <DocumentStatusBadge status={v.status} />
                    <span className="desk-muted" style={{ marginBottom: 0 }}>
                      {relativeTime(v.receivedAt ?? v.requestedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {!finished && (
              <>
                <Separator />
                <div style={{ paddingTop: 12 }}>
                  <UploadButton
                    clientId={doc.clientId}
                    requirementId={doc.requirementId ?? undefined}
                    label={doc.label ?? undefined}
                    buttonLabel="Upload new version"
                  />
                </div>
              </>
            )}
          </section>

          <section className="desk-card desk-block">
            <h3>Review history</h3>
            {doc.reviews.length === 0 ? (
              <p className="desk-muted">No review decisions recorded yet.</p>
            ) : (
              <ul>
                {doc.reviews.map((r) => (
                  <li key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--desk-line)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <DocumentStatusBadge status={r.decision} />
                        <span>{r.reviewer.name}</span>
                      </span>
                      <span className="desk-muted" style={{ marginBottom: 0 }}>
                        {dateTime(r.reviewedAt)}
                      </span>
                    </div>
                    {r.reason && <p className="desk-muted">{r.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </DeskChrome>
  )
}
