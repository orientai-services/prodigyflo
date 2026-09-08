'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { reviewHotLeadAction } from './actions'

type Decision = 'APPROVED' | 'REJECTED'

/**
 * Approve / Reject controls for one queue row. Both open a confirm dialog —
 * approval takes an optional note, rejection requires a reason the closer
 * team will see. The decision is the qualifier's, recorded to the audit log.
 */
export function ReviewActions({
  clientId,
  leadName,
  probability,
}: {
  clientId: string
  leadName: string
  probability: number
}) {
  const router = useRouter()
  const [decision, setDecision] = useState<Decision | null>(null)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  const open = decision !== null
  const rejecting = decision === 'REJECTED'
  const missingReason = rejecting && reason.trim().length === 0

  const close = () => {
    if (pending) return
    setDecision(null)
    setReason('')
  }

  const submit = () => {
    if (!decision || missingReason) return
    startTransition(async () => {
      const result = await reviewHotLeadAction({
        clientId,
        decision,
        reason: reason.trim() || undefined,
      })
      if (result.ok) {
        toast.success(
          result.decision === 'APPROVED'
            ? `${result.clientName} approved for closer work`
            : `${result.clientName} rejected — closers see the reason`,
        )
        setDecision(null)
        setReason('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1.5">
        <Button size="xs" variant="outline" onClick={() => setDecision('APPROVED')}>
          <CircleCheck data-slot="icon" className="text-success" /> Approve
        </Button>
        <Button size="xs" variant="destructive" onClick={() => setDecision('REJECTED')}>
          <CircleX data-slot="icon" /> Reject
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {rejecting ? `Reject ${leadName}?` : `Approve ${leadName} for closers?`}
            </DialogTitle>
            <DialogDescription>
              {rejecting
                ? `The AI scores this lead at ${Math.round(probability)}%, but your call overrides it. The reason is shown to the closer team and recorded in the audit log.`
                : `Scored ${Math.round(probability)}% by the AI — your approval is the human sign-off Phase 2 closers work from. It goes stale automatically if the score moves.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor={`review-reason-${clientId}`}>
              Reason{rejecting ? ' (required)' : ' (optional)'}
            </Label>
            <Textarea
              id={`review-reason-${clientId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={
                rejecting
                  ? 'Why this lead should not be worked yet — budget, timing, bad fit…'
                  : 'Anything the closer should know going in'
              }
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={rejecting ? 'destructive' : 'default'}
              onClick={submit}
              disabled={pending || missingReason}
            >
              {pending ? (
                <Loader2 data-slot="icon" className="animate-spin" />
              ) : rejecting ? (
                <CircleX data-slot="icon" />
              ) : (
                <CircleCheck data-slot="icon" />
              )}
              {rejecting ? 'Reject lead' : 'Approve lead'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
