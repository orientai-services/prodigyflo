import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Download, FileText } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

  return (
    <>
      <div className="border-b px-4 py-5 sm:px-6">
        <Link href="/documents" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
          <ArrowLeft className="size-3" /> Review queue
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              {doc.label ?? doc.requirement?.name ?? doc.fileName ?? 'Document'}
              <span className="text-muted-foreground text-sm font-normal">v{doc.version}</span>
              <DocumentStatusBadge status={doc.status} />
              {extraction && <ProviderBadge provider={extraction.provider} model={extraction.model} />}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              <Link href={`/clients/${doc.client.id}`} className="hover:underline">
                {fullName(doc.client)}
              </Link>
              {doc.requirement && <> · {doc.requirement.name}</>}
              {extraction?.detectedTypeLabel && (
                <>
                  {' '}
                  · detected as {extraction.detectedTypeLabel}
                  {extraction.typeConfidence !== null && ` (${extraction.typeConfidence}%)`}
                </>
              )}
              {doc.collector && <> · collector: {doc.collector.name}</>}
            </p>
          </div>
          <DocumentActions
            documentId={doc.id}
            canApprove={approval.ok && !finished && Boolean(extraction)}
            blocking={approval.blocking.map((b) => `${b.label} ${b.reason}`)}
            bulkEligibleCount={finished ? 0 : bulkEligible}
            showRerun={Boolean(doc.storageKey)}
            finished={finished}
          />
        </div>
        {doc.rejectionReason && (
          <p className="text-destructive mt-2 text-sm">Rejection reason: {doc.rejectionReason}</p>
        )}
      </div>

      <div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-2">
        {/* Original document */}
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Original document</CardTitle>
            {downloadUrl && (
              <Button size="sm" variant="ghost" render={<a href={downloadUrl} />}>
                <Download className="size-3.5" />
                Download
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!doc.storageKey || !fileUrl ? (
              <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-2 text-sm">
                <FileText className="size-6" />
                No file uploaded yet.
              </div>
            ) : doc.mimeType?.startsWith('image/') ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl} alt={doc.fileName ?? 'Uploaded document'} className="max-h-[70vh] w-full rounded-md border object-contain" />
            ) : (
              <iframe src={fileUrl} title={doc.fileName ?? 'Uploaded document'} className="h-[70vh] w-full rounded-md border bg-white" />
            )}
            <p className="text-muted-foreground mt-2 text-xs">
              {doc.fileName} · {doc.mimeType} · {fileSize(doc.sizeBytes)}
              {doc.checksum && <> · sha256 {doc.checksum.slice(0, 12)}…</>}
            </p>
          </CardContent>
        </Card>

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

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Extracted fields
                {extraction?.summary && (
                  <span className="text-muted-foreground mt-1 block text-xs font-normal">{extraction.summary}</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!extraction ? (
                <p className="text-muted-foreground px-4 pb-4 text-sm">No extraction has run for this document.</p>
              ) : extraction.status === 'FAILED' ? (
                <p className="text-destructive px-4 pb-4 text-sm">Extraction failed: {extraction.error}</p>
              ) : fields.length === 0 ? (
                <p className="text-muted-foreground px-4 pb-4 text-sm">
                  No field specification applies to this document type — approve or reject it on sight.
                </p>
              ) : (
                <ul className="divide-y">
                  {fields.map((field) => {
                    const effective = field.correctedValue?.trim() ? field.correctedValue : field.value
                    const missing = (extraction.missingFieldKeys ?? []).includes(field.key)
                    return (
                      <li key={field.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">
                              {field.label}
                              {requiredKeys.has(field.key) && <span className="text-destructive"> *</span>}
                            </p>
                            <p className="mt-0.5 text-sm">
                              {effective ? (
                                <span className={field.verification === 'REJECTED' ? 'line-through opacity-60' : ''}>
                                  {effective}
                                </span>
                              ) : (
                                <span className="text-muted-foreground italic">not extracted</span>
                              )}
                              {field.correctedValue?.trim() && field.value && field.correctedValue !== field.value && (
                                <span className="text-muted-foreground ml-2 text-xs line-through">{field.value}</span>
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

                        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          <ConfidenceMeter value={field.confidence} />
                          <VerificationBadge verification={field.verification} />
                          {field.sourcePage && <span>p. {field.sourcePage}</span>}
                          {missing && field.verification === 'UNVERIFIED' && (
                            <span className="text-orange-600 dark:text-orange-400">missing / below confidence floor</span>
                          )}
                          {field.verifiedBy && field.verifiedAt && (
                            <span>
                              {humanize(field.verification)} by {field.verifiedBy.name} {relativeTime(field.verifiedAt)}
                            </span>
                          )}
                        </div>

                        {field.sourceSnippet && (
                          <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]" title={field.sourceSnippet}>
                            “{field.sourceSnippet}”
                          </p>
                        )}
                        {field.conflictNote && (
                          <p className="mt-1 text-xs text-orange-600 dark:text-orange-400">
                            <AlertTriangle className="mr-1 inline size-3 align-[-2px]" />
                            {field.conflictNote}
                          </p>
                        )}
                        {field.reviewerNote && (
                          <p className="text-muted-foreground mt-1 text-xs">Reviewer note: {field.reviewerNote}</p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Versions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Versions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      {v.id === doc.id ? (
                        <span className="font-medium">v{v.version}</span>
                      ) : (
                        <Link href={`/documents/${v.id}`} className="font-medium hover:underline">
                          v{v.version}
                        </Link>
                      )}
                      <span className="text-muted-foreground text-xs">{v.fileName ?? 'awaiting upload'}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <DocumentStatusBadge status={v.status} />
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        {relativeTime(v.receivedAt ?? v.requestedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {!finished && (
                <>
                  <Separator />
                  <div className="px-4 py-3">
                    <UploadButton
                      clientId={doc.clientId}
                      requirementId={doc.requirementId ?? undefined}
                      label={doc.label ?? undefined}
                      buttonLabel="Upload new version"
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Review history */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Review history</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {doc.reviews.length === 0 ? (
                <p className="text-muted-foreground px-4 pb-4 text-sm">No review decisions recorded yet.</p>
              ) : (
                <ul className="divide-y">
                  {doc.reviews.map((r) => (
                    <li key={r.id} className="px-4 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <DocumentStatusBadge status={r.decision} />
                          <span>{r.reviewer.name}</span>
                        </span>
                        <span className="text-muted-foreground text-xs whitespace-nowrap">{dateTime(r.reviewedAt)}</span>
                      </div>
                      {r.reason && <p className="text-muted-foreground mt-0.5 text-xs">{r.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
