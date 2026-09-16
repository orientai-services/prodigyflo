import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Circle, Download, FileWarning } from 'lucide-react'
import { db } from '@/lib/db'
import { can, canAny, findClientInScope, requireUser } from '@/lib/rbac'
import { resolveForClient, type CysValueRow } from '@/lib/cys/data'
import type { CysDefinitionInput } from '@/lib/cys/resolve'
import { Badge } from '@/components/ui/badge'
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
    <div className="space-y-4">
      <section className="desk-card desk-block">
        <div className="desk-cal-head" style={{ padding: 0 }}>
          <h2 className="font-heading" style={{ fontSize: 24 }}>
            CYS workspace
          </h2>
          <span className={`desk-tag ${approved ? 'ok' : 'warn'}`}>
            {approved ? 'CYS ready' : 'CYS not ready'}
          </span>
        </div>
        <p className="desk-muted">
          {completion.requiredVerified} of {completion.requiredTotal} required fields verified.
          Packet READY is a separate gate on the case file. generateCysPackage writes a JSON draft only — no HTTP push.
        </p>
        {approved && (
          <p className="desk-muted">
            Approved {approver ? `by ${approver.name}` : ''} · {dateTime(readiness.approvedAt)}
          </p>
        )}
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
            <p className="desk-muted">
              Submission tracking:{' '}
              <Link href={`/submissions/${latestSubmission.id}`}>
                attempt {latestSubmission.attemptNumber} · {latestSubmission.status.replaceAll('_', ' ').toLowerCase()}
                {latestSubmission.externalRef ? ` · ref ${latestSubmission.externalRef}` : ''}
              </Link>{' '}
              · updated {relativeTime(latestSubmission.updatedAt)}
            </p>
          )}
      </section>

      {[...groups.entries()].map(([groupName, defs]) => (
        <section key={groupName} className="desk-card desk-block">
          <h3>{groupName}</h3>
          <div className="scroll-x">
            <table className="desk-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                  <th>Source</th>
                  <th>Status</th>
                  {canPrepare && <th></th>}
                </tr>
              </thead>
              <tbody>
                {defs.map((def) => {
                  const v: CysValueRow | undefined = valueByKey.get(def.key)
                  const status = v?.status ?? 'MISSING'
                  const attention = status === 'MISSING' || status === 'CONFLICT'
                  return (
                    <tr key={def.key} className={cn(attention && def.isRequired && 'bg-destructive/5')}>
                      <td>
                        <span className="font-medium">{def.label}</span>
                        {def.isRequired && (
                          <span className="desk-v miss" title="Required">
                            {' '}
                            *
                          </span>
                        )}
                        <div className="desk-muted" style={{ marginBottom: 0 }}>
                          {def.key}
                        </div>
                      </td>
                      <td>
                        {v?.value ? (
                          <span className="break-all">{v.value}</span>
                        ) : (
                          <span className="desk-v miss inline-flex items-center gap-1">
                            <FileWarning className="size-3.5" />
                            Missing
                          </span>
                        )}
                        {status === 'CONFLICT' && v?.conflictValue && (
                          <div className="desk-v miss">Conflicts with: “{v.conflictValue}”</div>
                        )}
                        {v?.note && <div className="desk-muted">{v.note}</div>}
                        {v?.verifiedAt && v.verifiedBy && (
                          <div className="desk-muted">
                            Verified by {v.verifiedBy.name} · {relativeTime(v.verifiedAt)}
                          </div>
                        )}
                      </td>
                      <td>{v?.sourceLabel ?? '—'}</td>
                      <td>
                        <StatusBadge status={status} confidence={v?.confidence ?? null} />
                      </td>
                      {canPrepare && (
                        <td>
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
        </section>
      ))}
    </div>
  )
}
