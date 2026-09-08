'use client'

import { useState, useTransition } from 'react'
import { Check, Pencil, X } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { correctField, rejectField, verifyField, type ActionResult } from './actions'

/**
 * Per-field review actions. Verify accepts the AI value as-is (only possible
 * when a value exists), Correct replaces it with a human-entered value, Reject
 * marks it unusable. All three record the reviewer and timestamp server-side.
 */
export function FieldActions({
  fieldId,
  label,
  value,
  hasValue,
}: {
  fieldId: string
  label: string
  value: string | null
  hasValue: boolean
}) {
  const [pending, start] = useTransition()
  const [dialog, setDialog] = useState<'correct' | 'reject' | null>(null)
  const [corrected, setCorrected] = useState(value ?? '')
  const [note, setNote] = useState('')

  const run = (fn: () => Promise<ActionResult>, close = false) =>
    start(async () => {
      const res = await fn()
      if (res.ok) {
        if (res.message) toast.success(res.message)
        if (close) setDialog(null)
      } else {
        toast.error(res.error)
      }
    })

  return (
    <div className="flex items-center gap-1">
      <Button
        size="icon-xs"
        variant="ghost"
        title={hasValue ? `Verify ${label}` : 'No value to verify — use Correct'}
        disabled={pending || !hasValue}
        onClick={() => run(() => verifyField(fieldId))}
      >
        <Check className="size-3.5 text-emerald-600" />
      </Button>
      <Button size="icon-xs" variant="ghost" title={`Correct ${label}`} disabled={pending} onClick={() => setDialog('correct')}>
        <Pencil className="size-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" title={`Reject ${label}`} disabled={pending} onClick={() => setDialog('reject')}>
        <X className="size-3.5 text-red-600" />
      </Button>

      <Dialog open={dialog === 'correct'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct “{label}”</DialogTitle>
            <DialogDescription>
              {value ? `The extracted value was “${value}”. ` : 'Nothing was extracted for this field. '}
              Enter what the document actually says.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`correct-${fieldId}`}>Corrected value</Label>
              <Input
                id={`correct-${fieldId}`}
                value={corrected}
                onChange={(e) => setCorrected(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`note-${fieldId}`}>Note (optional)</Label>
              <Textarea id={`note-${fieldId}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              disabled={pending || !corrected.trim()}
              onClick={() => run(() => correctField({ fieldId, value: corrected, note: note || undefined }), true)}
            >
              Save correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'reject'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject “{label}”</DialogTitle>
            <DialogDescription>
              Marks this extracted value as unusable. The document cannot be approved while a required field is
              rejected without a correction.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`reject-note-${fieldId}`}>Reason (optional)</Label>
            <Textarea id={`reject-note-${fieldId}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => rejectField({ fieldId, note: note || undefined }), true)}
            >
              Reject field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
