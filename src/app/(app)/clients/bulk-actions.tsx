'use client'

import { createContext, useContext, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2, StickyNote, UserRoundPen, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  bulkNoteAction,
  bulkReassignAction,
  bulkStageAction,
  type BulkActionResult,
} from './list-actions'

type Option = { value: string; label: string }

// ── Selection context ────────────────────────────────────────────────────────
// The table rows stay server-rendered; only the checkboxes and the action bar
// are client islands, wired together through this context.

type BulkContextValue = {
  selected: Set<string>
  toggle: (id: string) => void
  setMany: (ids: string[], on: boolean) => void
  clear: () => void
}

const BulkContext = createContext<BulkContextValue | null>(null)

function useBulk(): BulkContextValue {
  const ctx = useContext(BulkContext)
  if (!ctx) throw new Error('Bulk selection components must live inside <BulkProvider>.')
  return ctx
}

export function BulkProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const value = useMemo<BulkContextValue>(
    () => ({
      selected,
      toggle: (id) =>
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }),
      setMany: (ids, on) =>
        setSelected((prev) => {
          const next = new Set(prev)
          for (const id of ids) {
            if (on) next.add(id)
            else next.delete(id)
          }
          return next
        }),
      clear: () => setSelected(new Set()),
    }),
    [selected],
  )

  return <BulkContext.Provider value={value}>{children}</BulkContext.Provider>
}

export function BulkCheckbox({ id, name }: { id: string; name: string }) {
  const { selected, toggle } = useBulk()
  return (
    <Checkbox
      checked={selected.has(id)}
      onCheckedChange={() => toggle(id)}
      aria-label={`Select ${name}`}
    />
  )
}

/** Header checkbox: selects or clears every row on the current page. */
export function BulkSelectAll({ pageIds }: { pageIds: string[] }) {
  const { selected, setMany } = useBulk()
  const allOn = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const someOn = !allOn && pageIds.some((id) => selected.has(id))
  return (
    <Checkbox
      checked={allOn}
      indeterminate={someOn}
      onCheckedChange={() => setMany(pageIds, !allOn)}
      aria-label={allOn ? 'Clear this page' : 'Select every client on this page'}
    />
  )
}

// ── Single-row owner quick-reassign ──────────────────────────────────────────

export function OwnerReassign({
  clientId,
  ownerId,
  owners,
}: {
  clientId: string
  ownerId: string | null
  owners: Option[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <span className="inline-flex items-center gap-1.5">
      <NativeSelect
        size="sm"
        value={ownerId ?? ''}
        disabled={pending}
        aria-label="Reassign owner"
        onChange={(e) => {
          const next = e.target.value
          startTransition(async () => {
            const result = await bulkReassignAction({ clientIds: [clientId], ownerId: next })
            if (result.ok) {
              const failure = result.results?.find((r) => !r.ok)
              if (failure) toast.error(failure.error ?? 'Could not reassign this client.')
              else toast.success('Owner updated.')
              router.refresh()
            } else {
              toast.error(result.error ?? 'Could not reassign this client.')
            }
          })
        }}
        className="w-40"
      >
        <option value="">Unassigned</option>
        {owners.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      {pending && <Loader2 className="text-muted-foreground size-3 animate-spin" />}
    </span>
  )
}

// ── Sticky bulk bar ──────────────────────────────────────────────────────────

type Mode = 'stage' | 'owner' | 'note' | null

const REASON_REQUIRED = new Set(['CLOSED_LOST', 'ON_HOLD', 'NOT_QUALIFIED'])

export function BulkBar({
  stages,
  owners,
  canChangeStage,
  canReassign,
  canNote,
}: {
  stages: Option[]
  owners: Option[]
  canChangeStage: boolean
  canReassign: boolean
  canNote: boolean
}) {
  const router = useRouter()
  const { selected, clear } = useBulk()
  const [mode, setMode] = useState<Mode>(null)
  const [stage, setStage] = useState('')
  const [reason, setReason] = useState('')
  const [owner, setOwner] = useState('')
  const [note, setNote] = useState('')
  const [failures, setFailures] = useState<{ name: string; error?: string }[]>([])
  const [pending, startTransition] = useTransition()

  if (selected.size === 0) return null
  const ids = [...selected]
  const needsReason = REASON_REQUIRED.has(stage)

  const finish = (result: BulkActionResult, successVerb: string) => {
    if (!result.ok) {
      toast.error(result.error ?? 'That did not work.')
      return
    }
    const failed = result.results?.filter((r) => !r.ok) ?? []
    if (failed.length > 0) {
      setFailures(failed.map((f) => ({ name: f.name, error: f.error })))
      toast.warning(`${result.moved} ${successVerb}, ${failed.length} could not be.`)
    } else {
      setFailures([])
      setMode(null)
      toast.success(`${result.moved} client${result.moved === 1 ? '' : 's'} ${successVerb}.`)
      clear()
    }
    setStage('')
    setReason('')
    setOwner('')
    setNote('')
    router.refresh()
  }

  const run = (fn: () => Promise<BulkActionResult>, verb: string) =>
    startTransition(async () => finish(await fn(), verb))

  return (
    <>
      {/* left-60 keeps the bar clear of the desktop sidebar (w-60 in AppShell). */}
      <div className="bg-card/95 shadow-e2 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur lg:left-60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
          <span className="text-sm font-medium tabular-nums">
            {selected.size} selected
          </span>
          <span className="bg-border mx-1 hidden h-4 w-px sm:block" aria-hidden />
          {canChangeStage && (
            <Button variant="outline" size="sm" onClick={() => setMode('stage')}>
              <ArrowRight className="size-3.5" />
              Change stage
            </Button>
          )}
          {canReassign && (
            <Button variant="outline" size="sm" onClick={() => setMode('owner')}>
              <UserRoundPen className="size-3.5" />
              Reassign owner
            </Button>
          )}
          {canNote && (
            <Button variant="outline" size="sm" onClick={() => setMode('note')}>
              <StickyNote className="size-3.5" />
              Add note
            </Button>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clear}>
            <X className="size-3.5" />
            Clear selection
          </Button>
        </div>
      </div>

      <Dialog open={mode !== null} onOpenChange={(open) => !open && setMode(null)}>
        <DialogContent className="sm:max-w-md">
          {mode === 'stage' && (
            <>
              <DialogHeader>
                <DialogTitle>Move {ids.length} client{ids.length === 1 ? '' : 's'}</DialogTitle>
                <DialogDescription>
                  Each client is checked against its own pipeline rules — anyone who cannot make this
                  move is reported below instead of being forced through.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="bulk-stage">Destination stage</Label>
                  <NativeSelect
                    id="bulk-stage"
                    value={stage}
                    onChange={(e) => {
                      setStage(e.target.value)
                      setFailures([])
                    }}
                  >
                    <option value="">Choose a stage…</option>
                    {stages.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="bulk-reason">Reason{needsReason ? ' (required)' : ' (optional)'}</Label>
                  <Input
                    id="bulk-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={needsReason ? 'Why are these clients leaving the pipeline?' : 'Why this move?'}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={pending || !stage || (needsReason && !reason.trim())}
                  onClick={() =>
                    run(
                      () => bulkStageAction({ clientIds: ids, toStageKey: stage, reason: reason || undefined }),
                      'moved',
                    )
                  }
                >
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Move clients
                </Button>
              </DialogFooter>
            </>
          )}

          {mode === 'owner' && (
            <>
              <DialogHeader>
                <DialogTitle>Reassign {ids.length} client{ids.length === 1 ? '' : 's'}</DialogTitle>
                <DialogDescription>
                  The new owner takes over follow-ups immediately. Every change is recorded in the
                  audit log.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <Label htmlFor="bulk-owner">New owner</Label>
                <NativeSelect id="bulk-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">Unassigned</option>
                  {owners.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => bulkReassignAction({ clientIds: ids, ownerId: owner }), 'reassigned')}
                >
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Reassign
                </Button>
              </DialogFooter>
            </>
          )}

          {mode === 'note' && (
            <>
              <DialogHeader>
                <DialogTitle>Add a note to {ids.length} client{ids.length === 1 ? '' : 's'}</DialogTitle>
                <DialogDescription>
                  The same internal note lands on every selected record — visible to staff only,
                  never to clients.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <Label htmlFor="bulk-note">Note</Label>
                <Textarea
                  id="bulk-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="e.g. Called during the outage on Aug 22 — retry this week"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={pending || !note.trim()}
                  onClick={() => run(() => bulkNoteAction({ clientIds: ids, note }), 'noted')}
                >
                  {pending && <Loader2 className="size-3.5 animate-spin" />}
                  Add note
                </Button>
              </DialogFooter>
            </>
          )}

          {failures.length > 0 && (
            <div className="border-danger/40 bg-danger/5 rounded-md border px-3 py-2">
              <p className="text-danger text-xs font-medium">
                {failures.length} client{failures.length === 1 ? ' was' : 's were'} not changed:
              </p>
              <ul className="text-danger mt-1 max-h-40 space-y-1 overflow-y-auto text-xs">
                {failures.map((f, i) => (
                  <li key={i}>
                    <span className="font-medium">{f.name}</span>
                    {f.error && <span> — {f.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
