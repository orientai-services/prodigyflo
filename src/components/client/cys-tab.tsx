import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Circle, Download, FileWarning, ShieldCheck } from 'lucide-react'
import { db } from '@/lib/db'
import { can, canAny, findClientInScope, requireUser } from '@/lib/rbac'
import { resolveForClient, type CysValueRow } from '@/lib/cys/data'
import type { CysDefinitionInput } from '@/lib/cys/resolve'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { dateTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  ApproveReadinessDialog,
  FieldActions,
  GeneratePackageButton,
} from '@/lib/cys/ui/cys-islands'

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  VERIFIED: { label: 'Verified', className: 'bg-success/10 text-success border-transparent' },
  SUGGESTED: {
    label: 'Suggested',
    className: 'bg-warning/10 text-warning border-transparent',
  },
  CONFLICT: { label: 'Conflict', className: 'bg-destructive/10 text-destructive border-transparent' },
  MISSING: { label: 'Missing', className: 'bg-destructive/10 text-destructive border-transparent' },
}

function StatusBadge({ status, confidence }: { status: string; confidence: number | null }) {
  const s = STATUS_BADGE[status] ?? STATUS_BADGE.MISSING
  return (
    <Badge variant="outline" className={s.className}>
      {s.label}
      {status === 'SUGGESTED' && confidence !== null && (
        <span className="tabular-nums">{confidence}%</span>
      )}
    </Badge>
  )
}

/**
 * CYS readiness workspace: every configured handover field, where its value
 * came from, and whether a human has verified it. There is no CYS API — the
 * output is an approved, downloadable package delivered manually.
 */
export async function CysTab({ clientId }: { clientId: string }) {
  const user = await requireUser()
  if (!canAny(user, ['submissions:read', 'submissions:prepare'])) {
    return (
      <EmptyState
        icon="Lock"
        title="No submission access"
        description="You need submission permissions to view CYS readiness."
      />
    )
  }
  const client = await findClientInScope(user, clientId)
  if (!client) {
    return <EmptyState icon="Lock" title="This client is outside your scope" />
  }

  const { definitions, values, completion, checklist, blockers, readiness } =
    await resolveForClient(user, clientId)

  if (definitions.length === 0) {
    return (
      <EmptyState
        icon="Map"
        title="No CYS field map configured"
        description="Define the CYS handover fields in Settings before preparing this client."
        action={
          <Link href="/settings/cys" className="text-primary text-sm underline underline-offset-4">
            Open the CYS field map
          </Link>
        }
      />
    )
  }

  const [approver, latestSubmission] = await Promise.all([
    readiness.approvedById
      ? db.user.findUnique({ where: { id: readiness.approvedById }, select: { name: true } })
      : null,
    db.submission.findFirst({
      where: { clientId, destination: 'CYS' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, attemptNumber: true, externalRef: true, updatedAt: true },
    }),
  ])

  const canPrepare = can(user, 'submissions:prepare')
  const canApprove = can(user, 'submissions:approve')
  const valueByKey = new Map(values.map((v) => [v.fieldKey, v]))

  const groups = new Map<string, CysDefinitionInput[]>()
  for (const def of definitions) {
    const list = groups.get(def.groupName) ?? []
    list.push(def)
    groups.set(def.groupName, list)
  }

  const approved = readiness.approvedAt !== null

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Readiness summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            CYS readiness
            {approved ? (
              <Badge className="bg-success/10 text-success border-transparent" variant="outline">
                <ShieldCheck data-icon="inline-start" />
                Approved {approver ? `by ${approver.name}` : ''} · {dateTime(readiness.approvedAt)}
              </Badge>
            ) : (
              <Badge variant="secondary">Not yet approved</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {completion.requiredVerified} of {completion.requiredTotal} required fields verified.
            Handover to Cancel Your Solar is prepared here and delivered manually — there is no CYS
            API connection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
              <div
                className={cn('h-full rounded-full transition-all', completion.completionPct === 100 ? 'bg-success' : 'bg-primary')}
                style={{ width: `${completion.completionPct}%` }}
                role="progressbar"
                aria-valuenow={completion.completionPct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <span className="text-sm font-semibold tabular-nums">{completion.completionPct}%</span>
          </div>

          <ul className="grid gap-1.5 sm:grid-cols-3">
            {checklist.map((item) => (
              <li key={item.key} className="flex items-start gap-1.5 text-xs">
                {item.done ? (
                  <CheckCircle2 className="text-success mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <Circle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                )}
                <span className={item.done ? '' : 'text-muted-foreground'}>{item.label}</span>
              </li>
            ))}
          </ul>

          {!approved && blockers.length > 0 && (
            <div className="border-destructive/30 bg-destructive/5 rounded-md border px-3 py-2">
              <p className="text-destructive flex items-center gap-1.5 text-xs font-medium">
                <AlertTriangle className="size-3.5" />
                Blocking approval
              </p>
              <ul className="text-destructive/90 mt-1 list-disc pl-5 text-xs">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!approved && canApprove && (
              <ApproveReadinessDialog clientId={clientId} blockers={blockers} />
            )}
            {!approved && !canApprove && (
              <p className="text-muted-foreground text-xs">
                An authorized approver signs this off once every required field is verified.
              </p>
            )}
            {approved && canPrepare && (
              <GeneratePackageButton
                clientId={clientId}
                regenerate={readiness.packageGeneratedAt !== null}
              />
            )}
            {readiness.packageGeneratedAt && (
              <a
                href={`/api/cys/${clientId}/package`}
                className="text-primary inline-flex items-center gap-1 text-sm underline underline-offset-4"
              >
                <Download className="size-3.5" />
                Download package (generated {relativeTime(readiness.packageGeneratedAt)})
              </a>
            )}
          </div>

          {latestSubmission && (
            <p className="text-muted-foreground text-xs">
              Submission tracking:{' '}
              <Link
                href={`/submissions/${latestSubmission.id}`}
                className="text-primary underline underline-offset-4"
              >
                attempt {latestSubmission.attemptNumber} · {latestSubmission.status.replaceAll('_', ' ').toLowerCase()}
                {latestSubmission.externalRef ? ` · ref ${latestSubmission.externalRef}` : ''}
              </Link>{' '}
              · updated {relativeTime(latestSubmission.updatedAt)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Field groups */}
      {[...groups.entries()].map(([groupName, defs]) => (
        <Card key={groupName}>
          <CardHeader>
            <CardTitle className="text-sm">{groupName}</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr className="border-y">
                    <th className="px-4 py-2 text-left">Field</th>
                    <th className="px-4 py-2 text-left">Value</th>
                    <th className="px-4 py-2 text-left">Source</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    {canPrepare && <th className="px-4 py-2 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {defs.map((def) => {
                    const v: CysValueRow | undefined = valueByKey.get(def.key)
                    const status = v?.status ?? 'MISSING'
                    const attention = status === 'MISSING' || status === 'CONFLICT'
                    return (
                      <tr
                        key={def.key}
                        className={cn('border-b align-top', attention && def.isRequired && 'bg-destructive/5')}
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{def.label}</span>
                          {def.isRequired && (
                            <span className="text-destructive ml-1" title="Required">
                              *
                            </span>
                          )}
                          <span className="text-muted-foreground block text-xs">{def.key}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          {v?.value ? (
                            <span className="break-all">{v.value}</span>
                          ) : (
                            <span className="text-destructive inline-flex items-center gap-1 text-xs font-medium">
                              <FileWarning className="size-3.5" />
                              Missing
                            </span>
                          )}
                          {status === 'CONFLICT' && v?.conflictValue && (
                            <span className="text-destructive block text-xs">
                              Conflicts with: “{v.conflictValue}”
                            </span>
                          )}
                          {v?.note && (
                            <span className="text-muted-foreground block text-xs">{v.note}</span>
                          )}
                          {v?.verifiedAt && v.verifiedBy && (
                            <span className="text-muted-foreground block text-xs">
                              Verified by {v.verifiedBy.name} · {relativeTime(v.verifiedAt)}
                            </span>
                          )}
                        </td>
                        <td className="text-muted-foreground px-4 py-2.5 text-xs">
                          {v?.sourceLabel ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={status} confidence={v?.confidence ?? null} />
                        </td>
                        {canPrepare && (
                          <td className="px-4 py-2.5 text-right">
                            <FieldActions
                              clientId={clientId}
                              fieldKey={def.key}
                              label={def.label}
                              status={status}
                              value={v?.value ?? null}
                              conflictValue={v?.conflictValue ?? null}
                              dataType={def.dataType}
                            />
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
