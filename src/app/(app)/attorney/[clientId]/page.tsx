import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Circle, ExternalLink, FileText } from 'lucide-react'
import { can, requirePermissionPage } from '@/lib/rbac'
import { getAttorneyClientDetail } from '@/lib/attorney'
import { signedDocumentFileUrl } from '@/lib/storage'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { fileSize, fullName, shortDate } from '@/lib/format'
import { DocumentStatusBadge } from '../../documents/status-badge'
import { SubmissionStatusBadge } from '../../submissions/status'
import { ApproveAttorneyDialog } from '../attorney-islands'

export const metadata = { title: 'Attorney review' }

export default async function AttorneyClientPage({
  params,
}: {
  // Route types regenerate on the next dev/build pass; the shape is fixed here.
  params: Promise<{ clientId: string }>
}) {
  const user = await requirePermissionPage('submissions:prepare')
  const { clientId } = await params

  const detail = await getAttorneyClientDetail(user, clientId)
  if (!detail) notFound()
  const { client, requirements, readiness } = detail

  const canApprove = can(user, 'submissions:approve')

  // Newest version per requirement first; unmatched uploads (no requirement) last.
  const docsByRequirement = new Map<string, typeof client.documents>()
  for (const doc of client.documents) {
    if (!doc.requirementId) continue
    const list = docsByRequirement.get(doc.requirementId) ?? []
    list.push(doc)
    docsByRequirement.set(doc.requirementId, list)
  }
  for (const list of docsByRequirement.values()) list.sort((a, b) => b.version - a.version)

  const fileLinks = new Map<string, string | null>()
  await Promise.all(
    client.documents.map(async (d) => {
      fileLinks.set(d.id, await signedDocumentFileUrl(d))
    }),
  )

  const signedContract = client.contracts.find((c) => c.signedAt !== null) ?? null
  const approvedCount = readiness.requiredApproved

  return (
    <>
      <PageHeader
        title={`${fullName(client)} — attorney review`}
        description={`${approvedCount}/${readiness.requiredTotal} attorney-required documents approved · signed contract ${readiness.hasSignedContract ? 'on file' : 'missing'}.`}
        actions={
          canApprove && readiness.ready ? (
            <ApproveAttorneyDialog
              clientId={client.id}
              clientName={fullName(client)}
              documentCount={client.documents.filter((d) => d.status === 'APPROVED').length}
            />
          ) : undefined
        }
      >
        <div className="mt-3 flex items-center gap-3 text-sm">
          <Link href="/attorney" className="text-muted-foreground inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="size-3.5" />
            Back to queue
          </Link>
          <Link href={`/clients/${client.id}`} className="text-muted-foreground inline-flex items-center gap-1 hover:underline">
            Full client record
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
      </PageHeader>

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Attorney-required documents</CardTitle>
            </CardHeader>
            <CardContent>
              {requirements.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No document requirement is marked as attorney-required in this organization&apos;s
                  packages yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {requirements.map((req) => {
                    const versions = docsByRequirement.get(req.id) ?? []
                    const current = versions[0] ?? null
                    const url = current ? fileLinks.get(current.id) : null
                    return (
                      <li key={req.id} className="flex flex-wrap items-center gap-3 py-3">
                        {current?.status === 'APPROVED' ? (
                          <CheckCircle2 className="text-success size-4 shrink-0" />
                        ) : (
                          <Circle className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{req.name}</p>
                          <p className="text-muted-foreground truncate text-xs">
                            {current
                              ? `${current.label ?? current.fileName ?? 'Uploaded file'} · v${current.version}${current.receivedAt ? ` · received ${shortDate(current.receivedAt)}` : ''}${current.sizeBytes != null ? ` · ${fileSize(current.sizeBytes)}` : ''}`
                              : (req.description ?? 'Not requested or uploaded yet.')}
                          </p>
                        </div>
                        {current && <DocumentStatusBadge status={current.status} />}
                        {current && url && (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
                          >
                            <FileText className="size-3.5" />
                            View file
                          </a>
                        )}
                        {current && (
                          <Link
                            href={`/documents/${current.id}`}
                            className="text-muted-foreground text-xs hover:underline"
                          >
                            Review
                          </Link>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Attorney packages</CardTitle>
            </CardHeader>
            <CardContent>
              {client.submissions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No package yet. {canApprove ? 'Approving this client creates a draft package to deliver.' : 'A reviewer with approval rights creates the package once everything is approved.'}
                </p>
              ) : (
                <ul className="divide-y">
                  {client.submissions.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 py-3">
                      <SubmissionStatusBadge status={s.status} />
                      <span className="text-muted-foreground text-xs tabular-nums">
                        attempt {s.attemptNumber}
                        {s.submittedAt ? ` · delivered ${shortDate(s.submittedAt)}` : ''}
                      </span>
                      <Link
                        href={`/submissions/${s.id}`}
                        className="text-primary ml-auto text-xs font-medium hover:underline"
                      >
                        Open submission
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Readiness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {readiness.ready ? (
                <div className="border-success/40 bg-success/5 rounded-md border p-3">
                  <p className="text-success text-sm font-medium">Ready for attorney approval</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Every attorney-required document is approved and a signed contract is on file.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {readiness.blockers.map((b) => (
                    <li key={b} className="flex items-start gap-2 text-sm">
                      <Circle className="text-warning mt-0.5 size-3.5 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
              {canApprove && !readiness.ready && (
                <p className="text-muted-foreground text-xs">
                  The approve button appears once every blocker above is cleared — the server
                  refuses early approvals either way.
                </p>
              )}
              {!canApprove && (
                <p className="text-muted-foreground text-xs">
                  You can prepare this client; approval requires the submissions approval
                  permission.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Signed contract</CardTitle>
            </CardHeader>
            <CardContent>
              {signedContract ? (
                <div className="space-y-1 text-sm">
                  <p className="font-medium">{signedContract.counterparty}</p>
                  <p className="text-muted-foreground text-xs">
                    Signed {shortDate(signedContract.signedAt)}
                  </p>
                  <Badge variant="outline" className="border-transparent bg-success/10 text-success">
                    On file
                  </Badge>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No signed contract recorded. Record the signed solar agreement on the client
                  record before approving.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
