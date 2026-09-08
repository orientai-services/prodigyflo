'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Redo2, Send, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  markSubmissionResubmittedAction,
  markSubmissionSubmittedAction,
  recordSubmissionCorrectionsAction,
  type SubmissionActionResult,
} from './actions'

function useSubmit() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const run = (fn: () => Promise<SubmissionActionResult>, onOk: () => void, onError: (e: string) => void) =>
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        toast.success(result.message ?? 'Saved.')
        router.refresh()
        onOk()
      } else {
        onError(result.error)
      }
    })
  return { pending, run }
}

export function MarkSubmittedDialog({ submissionId }: { submissionId: string }) {
  const { pending, run } = useSubmit()
  const [open, setOpen] = useState(false)
  const [externalRef, setExternalRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Send />
        Mark as submitted
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as submitted</DialogTitle>
          <DialogDescription>
            Delivery to CYS is manual. Record the reference you received when you handed the package
            over — this does not send anything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="external-ref">External reference</Label>
          <Input
            id="external-ref"
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            placeholder="e.g. CYS-2026-0142"
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () => markSubmissionSubmittedAction({ submissionId, externalRef }),
                () => setOpen(false),
                setError,
              )
            }
          >
            {pending && <Loader2 className="animate-spin" />}
            Record delivery
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RecordCorrectionsDialog({ submissionId }: { submissionId: string }) {
  const { pending, run } = useSubmit()
  const [open, setOpen] = useState(false)
  const [corrections, setCorrections] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Undo2 />
        Record corrections requested
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corrections requested by CYS</DialogTitle>
          <DialogDescription>One requested correction per line.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={corrections}
          onChange={(e) => setCorrections(e.target.value)}
          rows={5}
          placeholder={'Utility account number illegible\nContract missing final signature page'}
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () => recordSubmissionCorrectionsAction({ submissionId, corrections }),
                () => setOpen(false),
                setError,
              )
            }
          >
            {pending && <Loader2 className="animate-spin" />}
            Save corrections
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MarkResubmittedDialog({ submissionId }: { submissionId: string }) {
  const { pending, run } = useSubmit()
  const [open, setOpen] = useState(false)
  const [externalRef, setExternalRef] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Redo2 />
        Mark as resubmitted
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as resubmitted</DialogTitle>
          <DialogDescription>
            Records that the corrected package was manually re-delivered to CYS and bumps the
            attempt number.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="resubmit-ref">New external reference (optional)</Label>
          <Input
            id="resubmit-ref"
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  markSubmissionResubmittedAction({
                    submissionId,
                    externalRef: externalRef || undefined,
                  }),
                () => setOpen(false),
                setError,
              )
            }
          >
            {pending && <Loader2 className="animate-spin" />}
            Record re-delivery
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
