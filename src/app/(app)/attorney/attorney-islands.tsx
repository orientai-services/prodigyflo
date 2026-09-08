'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Scale } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { approveAttorneySubmissionAction } from './actions'

export function ApproveAttorneyDialog({
  clientId,
  clientName,
  documentCount,
}: {
  clientId: string
  clientName: string
  documentCount: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [blockers, setBlockers] = useState<string[]>([])

  const submit = () =>
    startTransition(async () => {
      setError(null)
      setBlockers([])
      const result = await approveAttorneySubmissionAction({ clientId, note: note || undefined })
      if (result.ok) {
        toast.success(result.message ?? 'Attorney package approved.')
        setOpen(false)
        router.refresh()
      } else {
        setError(result.error)
        setBlockers(result.blockers ?? [])
      }
    })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Scale />
        Approve for attorney
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve attorney package</DialogTitle>
          <DialogDescription>
            Freezes the {documentCount} approved document{documentCount === 1 ? '' : 's'} for{' '}
            {clientName} into a draft package. Nothing is sent — a person delivers it and records
            the hand-off under Submissions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="attorney-note">Note for the record (optional)</Label>
          <Textarea
            id="attorney-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. Contract addendum reviewed with the client on the phone."
          />
        </div>
        {error && (
          <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
            <p className="text-destructive text-sm font-medium">{error}</p>
            {blockers.length > 0 && (
              <ul className="text-destructive/90 mt-1.5 list-disc space-y-0.5 pl-4 text-xs">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending} onClick={submit}>
            {pending && <Loader2 className="animate-spin" />}
            Approve package
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
