import Link from 'next/link'
import { AlertTriangle, Eye, FileCheck2, SearchCheck } from 'lucide-react'
import type { DocumentStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { can, requireClientInScope, requireUser } from '@/lib/rbac'
import { signedDocumentFileUrl } from '@/lib/storage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { relativeTime, shortDate } from '@/lib/format'
import {
  ConfidenceMeter,
  DocumentStatusBadge,
  ProviderBadge,
  VerificationBadge,
} from '@/app/(app)/documents/status-badge'
import { RequestDocumentsDialog } from '@/app/(app)/documents/request-documents'
import { UploadButton } from '@/app/(app)/documents/upload-button'
import { MarkContractSignedDialog } from '@/app/(app)/clients/[clientId]/mark-contract-signed'

/**
 * Documents tab on the client detail page. Server component: does its own
 * auth + scope check, then renders the requirement checklist, every uploaded
 * version, extraction state, and the working upload / request controls.
 */
export async function DocumentsTab({ clientId }: { clientId: string }) {
  const user = await requireUser()
  await requireClientInScope(user, clientId)

  const canUpload = can(user, 'documents:upload')
  const canRequest = can(user, 'documents:request')
  const canReview = can(user, 'documents:review')
  const canAssign = can(user, 'documents:assign_collector')

  const canUpdate = can(user, 'clients:update')

  const [requirements, documents, collectors, signedContract] = await Promise.all([
    db.documentRequirement.findMany({
      where: { package: { organizationId: user.organizationId } },
      orderBy: [{ package: { isDefault: 'desc' } }, { position: 'asc' }],
      include: { package: { select: { name: true, isDefault: true } } },
    }),
    db.clientDocument.findMany({
      where: { clientId },
      orderBy: { version: 'desc' },
      include: {
        requirement: { select: { id: true, name: true } },
        collector: { select: { name: true } },
        reviews: { select: { id: true }, take: 1 },
        extractions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            fields: {
              select: { key: true, label: true, value: true, correctedValue: true, confidence: true, verification: true, conflictNote: true },
            },
          },
        },
      },
    }),
    canRequest && canAssign
      ? db.user.findMany({
          where: { organizationId: user.organizationId, deletedAt: null, isActive: true, role: { key: 'DOCUMENT_COLLECTOR' } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
    // The fact the attorney readiness gate checks — surfaced (and recordable)
    // right where the document work happens.
    db.contract.findFirst({
      where: { clientId, signedAt: { not: null } },
      orderBy: { signedAt: 'desc' },
      select: { id: true, counterparty: true, signedAt: true },
    }),
  ])

  type Doc = (typeof documents)[number]
  const byRequirement = new Map<string, Doc[]>()
  const adHoc: Doc[] = []
  for (const doc of documents) {
    if (doc.requirementId) {
      const list = byRequirement.get(doc.requirementId) ?? []
      list.push(doc)
      byRequirement.set(doc.requirementId, list)
    } else {
      adHoc.push(doc)
    }
  }

  const OPEN: DocumentStatus[] = ['REQUESTED', 'RECEIVED', 'PROCESSING', 'UNDER_REVIEW', 'MISSING_INFORMATION']
  const requiredReqs = requirements.filter((r) => r.isRequired)
  const approvedRequired = requiredReqs.filter((r) => (byRequirement.get(r.id) ?? []).some((d) => d.status === 'APPROVED')).length

  const fileUrls = new Map<string, string>()
  for (const doc of documents) {
    if (doc.storageKey) {
      const url = await signedDocumentFileUrl(doc)
      if (url) fileUrls.set(doc.id, url)
    }
  }

  const renderDoc = (doc: Doc, latest: boolean) => {
    const extraction = doc.extractions[0]
    const fields = extraction?.fields ?? []
    const reviewed = fields.filter((f) => f.verification !== 'UNVERIFIED').length
    const conflicts = fields.filter((f) => f.conflictNote).length
    const url = fileUrls.get(doc.id)
    return (
      <div key={doc.id} className={latest ? '' : 'opacity-70'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground text-xs font-medium">v{doc.version}</span>
            <DocumentStatusBadge status={doc.status} />
            {doc.fileName && <span className="text-muted-foreground truncate text-xs">{doc.fileName}</span>}
            {extraction && <ProviderBadge provider={extraction.provider} model={extraction.model} />}
          </div>
          <div className="flex items-center gap-1">
            {url && (
              <Button size="sm" variant="ghost" render={<a href={url} target="_blank" rel="noreferrer" />}>
                <Eye className="size-3.5" />
                View file
              </Button>
            )}
            {canReview && doc.storageKey && (
              <Button size="sm" variant="ghost" render={<Link href={`/documents/${doc.id}`} />}>
                <SearchCheck className="size-3.5" />
                Review
              </Button>
            )}
          </div>
        </div>

        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {doc.status === 'REQUESTED' ? (
            <span>
              Requested {relativeTime(doc.requestedAt)}
              {doc.slaDueAt && <> · due {shortDate(doc.slaDueAt)}</>}
            </span>
          ) : (
            <span>Received {relativeTime(doc.receivedAt ?? doc.requestedAt)}</span>
          )}
          {doc.collector && <span>Collector: {doc.collector.name}</span>}
          {fields.length > 0 && (
            <span className="tabular-nums">
              {reviewed}/{fields.length} fields reviewed
            </span>
          )}
          {extraction && (extraction.missingFieldKeys?.length ?? 0) > 0 && (
            <span className="text-orange-600 dark:text-orange-400">
              {extraction.missingFieldKeys.length} required field(s) missing
            </span>
          )}
          {conflicts > 0 && (
            <span className="text-orange-600 dark:text-orange-400">
              <AlertTriangle className="mr-0.5 inline size-3 align-[-2px]" />
              {conflicts} conflict{conflicts === 1 ? '' : 's'} with the client record
            </span>
          )}
        </div>

        {doc.clientVisibleComment && (
          <p className="text-muted-foreground mt-1 text-xs italic">“{doc.clientVisibleComment}”</p>
        )}
        {doc.rejectionReason && <p className="text-destructive mt-1 text-xs">Rejected: {doc.rejectionReason}</p>}

        {latest && fields.length > 0 && (
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {fields.map((f) => {
              const effective = f.correctedValue?.trim() ? f.correctedValue : f.value
              return (
                <li key={f.key} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
                  <span className="min-w-0">
                    <span className="text-muted-foreground">{f.label}:</span>{' '}
                    {effective ? (
                      <span className={f.verification === 'REJECTED' ? 'line-through opacity-60' : ''}>{effective}</span>
                    ) : (
                      <span className="text-muted-foreground italic">—</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <ConfidenceMeter value={f.confidence} />
                    <VerificationBadge verification={f.verification} />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-sm">
            {approvedRequired}/{requiredReqs.length} required documents approved
          </p>
          {signedContract ? (
            <Badge variant="outline" className="bg-success/10 text-success border-transparent">
              <FileCheck2 data-icon="inline-start" />
              Contract signed · {signedContract.counterparty} · {shortDate(signedContract.signedAt)}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              No signed contract on file
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canUpdate && !signedContract && <MarkContractSignedDialog clientId={clientId} />}
          {canRequest && (
            <RequestDocumentsDialog
              clientId={clientId}
              requirements={requirements.map((r) => ({
                id: r.id,
                name: r.name,
                isRequired: r.isRequired,
                alreadyOpen: (byRequirement.get(r.id) ?? []).some((d) => OPEN.includes(d.status) || d.status === 'APPROVED'),
              }))}
              collectors={collectors}
              canAssignCollector={canAssign}
            />
          )}
          {canUpload && <UploadButton clientId={clientId} buttonLabel="Upload other document" variant="secondary" />}
        </div>
      </div>

      {requirements.length === 0 && documents.length === 0 ? (
        <EmptyState
          icon="FileStack"
          title="No document requirements configured"
          description="An admin can define document packages under Settings → Document packages."
        />
      ) : (
        <>
          {requirements.map((req) => {
            const docs = byRequirement.get(req.id) ?? []
            const latest = docs[0]
            return (
              <Card key={req.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-sm">
                    {req.name}
                    {req.isRequired && <span className="text-destructive"> *</span>}
                    <span className="text-muted-foreground ml-2 text-xs font-normal">{req.category.toLowerCase().replace(/_/g, ' ')}</span>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {canUpload && (
                      <UploadButton
                        clientId={clientId}
                        requirementId={req.id}
                        label={req.name}
                        buttonLabel={latest?.storageKey ? 'Upload new version' : 'Upload'}
                      />
                    )}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {docs.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Not requested yet.</p>
                  ) : (
                    docs.map((doc, i) => renderDoc(doc, i === 0))
                  )}
                </CardContent>
              </Card>
            )
          })}

          {adHoc.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Other documents</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">{adHoc.map((doc, i) => renderDoc(doc, i === 0))}</CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
