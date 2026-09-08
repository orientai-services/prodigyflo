'use client'

import { useState, useTransition } from 'react'
import { FilePlus2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { requestDocuments } from './actions'

type RequirementOption = { id: string; name: string; isRequired: boolean; alreadyOpen: boolean }
type CollectorOption = { id: string; name: string }

/**
 * "Request documents" dialog: pick requirements, optionally assign a
 * collector, set an SLA. Creates REQUESTED document rows the messaging slice
 * can chase.
 */
export function RequestDocumentsDialog({
  clientId,
  requirements,
  collectors,
  canAssignCollector,
}: {
  clientId: string
  requirements: RequirementOption[]
  collectors: CollectorOption[]
  canAssignCollector: boolean
}) {
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collectorId, setCollectorId] = useState('')
  const [dueDays, setDueDays] = useState(3)

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const submit = () =>
    start(async () => {
      const res = await requestDocuments({
        clientId,
        requirementIds: [...selected],
        collectorId: collectorId || undefined,
        dueDays,
      })
      if (res.ok) {
        toast.success(res.message ?? 'Documents requested.')
        setOpen(false)
        setSelected(new Set())
      } else {
        toast.error(res.error)
      }
    })

  const selectable = requirements.filter((r) => !r.alreadyOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <FilePlus2 className="size-3.5" />
        Request documents
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request documents</DialogTitle>
          <DialogDescription>
            Creates a pending request per selected document, with a due date the reminders can chase.
          </DialogDescription>
        </DialogHeader>

        {selectable.length === 0 ? (
          <p className="text-muted-foreground text-sm">Every configured document is already requested or on file.</p>
        ) : (
          <div className="grid gap-2">
            {selectable.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                <span>{r.name}</span>
                {r.isRequired && <span className="text-muted-foreground text-xs">required</span>}
              </label>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {canAssignCollector && collectors.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="req-collector">Collector (optional)</Label>
              <NativeSelect
                id="req-collector"
                value={collectorId}
                onChange={(e) => setCollectorId(e.target.value)}
                className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3"
              >
                <option value="">Unassigned</option>
                {collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="req-due">Due within (days)</Label>
            <NativeSelect
              id="req-due"
              value={dueDays}
              onChange={(e) => setDueDays(Number(e.target.value))}
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3"
            >
              {[1, 2, 3, 5, 7, 14].map((d) => (
                <option key={d} value={d}>
                  {d} day{d === 1 ? '' : 's'}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={pending || selected.size === 0} onClick={submit}>
            Request {selected.size || ''} document{selected.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
