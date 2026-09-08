'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, RotateCcw, Wrench } from 'lucide-react'
import type { IntakeStatus } from '@prisma/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { relativeTime } from '@/lib/format'
import { CRM_FIELDS } from '@/lib/intake/mapping'
import { fixSubmissionMapping, retryIntakeSubmission } from './actions'

export type SubmissionRow = {
  id: string
  sourceName: string
  externalId: string
  status: IntakeStatus
  attemptCount: number
  createdAt: string
  error: string | null
  matchedOn: string | null
  unmappedKeys: string[]
  rawPayload: Record<string, unknown>
  client: { id: string; name: string } | null
}

const STATUS_BADGE: Record<IntakeStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' }> = {
  RECEIVED: { label: 'Received', variant: 'ghost' },
  APPLIED: { label: 'Applied', variant: 'default' },
  DUPLICATE: { label: 'Matched', variant: 'secondary' },
  NEEDS_MAPPING: { label: 'Needs mapping', variant: 'outline' },
  FAILED: { label: 'Failed', variant: 'destructive' },
}

const RETRYABLE: IntakeStatus[] = ['FAILED', 'NEEDS_MAPPING']

function FixMappingDialog({
  row,
  open,
  onClose,
}: {
  row: SubmissionRow
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [saveToSource, setSaveToSource] = useState(true)

  const keys = row.unmappedKeys.length ? row.unmappedKeys : Object.keys(row.rawPayload)

  const apply = () => {
    startTransition(async () => {
      const result = await fixSubmissionMapping({ submissionId: row.id, overrides, saveToSource })
      if (result.ok) {
        toast.success(`Submission re-applied — ${STATUS_BADGE[result.status].label.toLowerCase()}.`)
        onClose()
        router.refresh()
      } else {
        toast.error(result.error ?? Object.values(result.fieldErrors ?? {})[0] ?? 'Could not apply mapping.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix mapping</DialogTitle>
          <DialogDescription>
            Point each incoming key from this payload at a CRM field, then re-apply the submission.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">This payload has no unmapped keys.</p>
          ) : (
            keys.map((key) => {
              const crmField = Object.entries(overrides).find(([, v]) => v === key)?.[0] ?? ''
              return (
                <div key={key} className="flex items-center gap-2">
                  <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs" title={key}>
                    {key}
                  </code>
                  <span className="text-muted-foreground text-xs">→</span>
                  <NativeSelect
                    value={crmField}
                    onChange={(e) => {
                      setOverrides((prev) => {
                        const next = { ...prev }
                        // One incoming key per CRM field: drop any earlier claim.
                        for (const [f, v] of Object.entries(next)) if (v === key || f === e.target.value) delete next[f]
                        if (e.target.value) next[e.target.value] = key
                        return next
                      })
                    }}
                    aria-label={`CRM field for ${key}`}
                    className="border-input bg-background h-8 w-44 rounded-md border px-2 text-sm outline-none"
                  >
                    <option value="">Not mapped</option>
                    {CRM_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )
            })
          )}
        </div>

        {row.error && <p className="text-destructive text-xs">{row.error}</p>}

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={saveToSource} onCheckedChange={(v) => setSaveToSource(v === true)} />
          Save these mappings to the source for future submissions
        </label>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={apply} disabled={pending || Object.keys(overrides).length === 0}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            Apply mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SubmissionsTable({ rows, canManage }: { rows: SubmissionRow[]; canManage: boolean }) {
  const router = useRouter()
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [fixing, setFixing] = useState<SubmissionRow | null>(null)
  const [, startTransition] = useTransition()

  const retry = (row: SubmissionRow) => {
    setRetryingId(row.id)
    startTransition(async () => {
      const result = await retryIntakeSubmission(row.id)
      setRetryingId(null)
      if (result.ok) {
        if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
          toast.success(`Retry succeeded — ${STATUS_BADGE[result.status].label.toLowerCase()}.`)
        } else {
          toast.warning(result.error ?? 'Retry ran but the submission is still stuck.')
        }
        router.refresh()
      } else {
        toast.error(result.error ?? 'Retry failed.')
      }
    })
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="Inbox"
        title="No submissions here"
        description="Inbound webhook deliveries and sheet rows will appear in this list."
      />
    )
  }

  return (
    <>
      <div className="scroll-x">
        <table className="w-full min-w-[52rem] text-sm tabular-nums">
          <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
            <tr className="border-b">
              <th className="px-4 py-2 text-left">Received</th>
              <th className="px-4 py-2 text-left">Source</th>
              <th className="px-4 py-2 text-left">External ID</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Client</th>
              <th className="px-4 py-2 text-left">Detail</th>
              {canManage && <th className="px-4 py-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-muted/40 border-b transition-colors">
                <td className="text-muted-foreground px-4 py-2.5 text-xs whitespace-nowrap">
                  {relativeTime(row.createdAt)}
                </td>
                <td className="px-4 py-2.5">{row.sourceName}</td>
                <td className="text-muted-foreground max-w-40 truncate px-4 py-2.5 font-mono text-xs" title={row.externalId}>
                  {row.externalId}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={STATUS_BADGE[row.status].variant}>{STATUS_BADGE[row.status].label}</Badge>
                  {row.attemptCount > 1 && (
                    <span className="text-muted-foreground ml-1.5 text-xs">×{row.attemptCount}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {row.client ? (
                    <Link href={`/clients/${row.client.id}`} className="hover:underline">
                      {row.client.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-muted-foreground max-w-64 px-4 py-2.5 text-xs">
                  {row.status === 'DUPLICATE' && row.matchedOn ? (
                    <>Matched on {row.matchedOn}</>
                  ) : row.error ? (
                    <span className="text-destructive line-clamp-2" title={row.error}>
                      {row.error}
                    </span>
                  ) : row.unmappedKeys.length > 0 ? (
                    <>{row.unmappedKeys.length} unmapped key{row.unmappedKeys.length === 1 ? '' : 's'}</>
                  ) : (
                    '—'
                  )}
                </td>
                {canManage && (
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {RETRYABLE.includes(row.status) && (
                      <>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => retry(row)}
                          disabled={retryingId === row.id}
                          title="Re-run the apply pipeline"
                        >
                          {retryingId === row.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3" />
                          )}
                          Retry
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setFixing(row)} title="Map fields and re-apply">
                          <Wrench className="size-3" />
                          Fix mapping
                        </Button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fixing && <FixMappingDialog row={fixing} open onClose={() => setFixing(null)} />}
    </>
  )
}
