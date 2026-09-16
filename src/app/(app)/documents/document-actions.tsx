'use client'

import { useState, useTransition } from 'react'
import { CheckCheck, FileUp, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  approveDocument,
  bulkVerifyHighConfidence,
  rejectDocument,
  requestReupload,
  rerunExtraction,
  type ActionResult,
} from './actions'

/**
 * Document-level decisions. Approve is disabled — with the reasons shown —
 * until every required field is verified or corrected; the server action
 * enforces the same invariant regardless.
 */
export function DocumentActions({
  documentId,
  canApprove,
  blocking,
  bulkEligibleCount,
  showRerun,
  finished,
}: {
  documentId: string
  canApprove: boolean
  blocking: string[]
  bulkEligibleCount: number
  showRerun: boolean
  finished: boolean
}) {
  const [pending, start] = useTransition()
  const [dialog, setDialog] = useState<'reject' | 'reupload' | null>(null)
  const [reason, setReason] = useState('')

  const run = (fn: () => Promise<ActionResult>, close = false) =>
    start(async () => {
      const res = await fn()
      if (res.ok) {
        toast.success(res.message ?? 'Done.')
        if (close) {
          setDialog(null)
          setReason('')
        }
      } else {
        toast.error(res.error)
      }
    })

  if (finished) return null

  const approveButton = (
    <Button size="sm" disabled={pending || !canApprove} onClick={() => run(() => approveDocument(documentId))}>
      <ShieldCheck className="size-3.5" />
      Approve
    </Button>
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      {bulkEligibleCount > 0 && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => bulkVerifyHighConfidence(documentId))}>
          <CheckCheck className="size-3.5" />
          Verify all ≥90% ({bulkEligibleCount})
        </Button>
      )}

      {canApprove ? (
        approveButton
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{approveButton}</TooltipTrigger>
          <TooltipContent>
            <p className="max-w-64">
              {blocking.length
                ? `Blocked: ${blocking.join('; ')}`
                : 'This document cannot be approved yet.'}
            </p>
          </TooltipContent>
        </Tooltip>
      )}

      <Button size="sm" variant="destructive" disabled={pending} onClick={() => setDialog('reject')}>
        <ShieldX className="size-3.5" />
        Reject
      </Button>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => setDialog('reupload')}>
        <FileUp className="size-3.5" />
        Request re-upload
      </Button>
      {showRerun && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => rerunExtraction(documentId))}>
          <RefreshCw className="size-3.5" />
          Re-run extraction
        </Button>
      )}

      <Dialog open={dialog === 'reject'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="desk desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reject this document</DialogTitle>
            <DialogDescription>A reason is required — the client and team will see it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="doc-reject-reason">Reason</Label>
            <Textarea
              id="doc-reject-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The statement is older than 90 days."
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending || reason.trim().length < 5}
              onClick={() => run(() => rejectDocument({ documentId, reason }), true)}
            >
              Reject document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'reupload'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="desk desk-dialog sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Request a re-upload</DialogTitle>
            <DialogDescription>
              Opens a new pending version of this document. The current file and its review history are kept.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="doc-reupload-note">Note to the uploader (optional)</Label>
            <Textarea
              id="doc-reupload-note"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Please send all pages, including the back side."
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => requestReupload({ documentId, note: reason || undefined }), true)}
            >
              Request re-upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
