'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileSignature, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
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
import { markContractSignedAction } from './contract-actions'

/**
 * The write path for "signed contract on file" — the fact the attorney
 * readiness gate checks. Hiding this button is not the protection: the server
 * action re-checks permission and scope either way.
 */
export function MarkContractSignedDialog({ clientId }: { clientId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [counterparty, setCounterparty] = useState('')
  const [signedOn, setSignedOn] = useState('')
  const [productType, setProductType] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const result = await markContractSignedAction({
        clientId,
        counterparty,
        signedOn,
        productType: productType || null,
        notes: notes || undefined,
      })
      if (result.ok) {
        toast.success('Signed contract recorded.')
        setOpen(false)
        router.refresh()
      } else {
        setError(result.error)
      }
    })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <FileSignature />
        Mark contract signed
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the signed contract</DialogTitle>
          <DialogDescription>
            Puts the signed solar agreement on file for this client — the attorney handover cannot
            be approved without it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="contract-counterparty">Solar company (counterparty)</Label>
            <Input
              id="contract-counterparty"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="e.g. Helios Home Energy"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contract-signed-on">Signed on</Label>
              <Input
                id="contract-signed-on"
                type="date"
                value={signedOn}
                onChange={(e) => setSignedOn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contract-product-type">Product type (optional)</Label>
              <NativeSelect
                id="contract-product-type"
                value={productType}
                onChange={(e) => setProductType(e.target.value)}
                className="w-full"
              >
                <option value="">Not specified</option>
                <option value="lease">Lease</option>
                <option value="PPA">PPA</option>
                <option value="loan">Loan</option>
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="contract-notes">Note for the record (optional)</Label>
            <Textarea
              id="contract-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Original signed agreement uploaded under Signed original contract."
            />
          </div>
        </div>
        {error && (
          <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
            <p className="text-destructive text-sm font-medium">{error}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending || !counterparty.trim() || !signedOn} onClick={submit}>
            {pending && <Loader2 className="animate-spin" />}
            Record signed contract
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
