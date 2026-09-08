'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/ui/native-select'
import { advanceStageAction } from './actions'

const REASON_REQUIRED = new Set(['CLOSED_LOST', 'ON_HOLD', 'NOT_QUALIFIED'])

export type StageOption = { key: string; name: string; universal?: boolean }

export function StageAdvance({
  clientId,
  currentStageName,
  options,
}: {
  clientId: string
  currentStageName: string
  options: StageOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [blockers, setBlockers] = useState<string[]>([])
  const [pending, startTransition] = useTransition()

  if (options.length === 0) return null
  const selected = options.find((o) => o.key === target)
  const needsReason = REASON_REQUIRED.has(target)

  const submit = () => {
    if (!target) return
    setBlockers([])
    startTransition(async () => {
      const result = await advanceStageAction({
        clientId,
        toStageKey: target,
        reason: reason || undefined,
        note: note || undefined,
      })
      if (result.ok) {
        toast.success(`Moved to ${selected?.name ?? 'new stage'}`)
        setOpen(false)
        setTarget('')
        setReason('')
        setNote('')
        router.refresh()
      } else {
        setBlockers(result.blockers ?? [])
        toast.error(result.error ?? 'Could not move this client.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <ArrowRight className="size-3.5" />
        Advance stage
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move out of “{currentStageName}”</DialogTitle>
          <DialogDescription>
            Only transitions this pipeline allows are listed. Blocked moves explain why.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="stage-target">Next stage</Label>
            <NativeSelect
              id="stage-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value)
                setBlockers([])
              }}
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-3"
            >
              <option value="">Choose a stage…</option>
              {options.filter((o) => !o.universal).map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                </option>
              ))}
              <optgroup label="Always available">
                {options.filter((o) => o.universal).map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            </NativeSelect>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="stage-reason">
              Reason{needsReason ? ' (required)' : ' (optional)'}
            </Label>
            <Input
              id="stage-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={needsReason ? 'Why is this client leaving the pipeline?' : 'Why this move?'}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="stage-note">Note (optional)</Label>
            <Textarea
              id="stage-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Context for the next person who opens this record"
            />
          </div>

          {blockers.length > 0 && (
            <ul className="border-danger/40 bg-danger/5 text-danger rounded-md border px-3 py-2 text-xs">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || !target || (needsReason && !reason.trim())}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            Move client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
