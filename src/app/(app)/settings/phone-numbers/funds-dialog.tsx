'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, Loader2, Plus, Send } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { recordTopUpAction, requestFundsAction } from './actions'
import type { ConsoleVM } from './types'

/**
 * Adding money to an account's phone balance.
 *
 * Who may do it is the whole design: an agency operator RECORDS funds that
 * actually arrived (transfer, invoice, card taken at the agency), which is an
 * attestation and therefore audited. An account's own admin can only ASK — if
 * they could credit themselves, the balance would gate nothing at all.
 */

const PRESETS = [2500, 5000, 10_000, 25_000]

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function FundsDialog({ vm }: { vm: ConsoleVM }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [amount, setAmount] = useState('25.00')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)

  const canRecord = vm.isAgencyOperator
  const cents = Math.round(Number.parseFloat(amount.replace(/[^0-9.]/g, '')) * 100)
  const valid = Number.isFinite(cents) && cents >= 500

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const res = canRecord
        ? await recordTopUpAction({ organizationId: vm.organizationId, amountCents: cents, reference })
        : await requestFundsAction({ amountCents: cents, note: reference })
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (canRecord) {
        const resumed = 'resumed' in res ? res.resumed : 0
        toast.success(
          resumed > 0
            ? `${dollars(cents)} added — ${resumed} suspended line${resumed === 1 ? '' : 's'} back in service.`
            : `${dollars(cents)} added to the balance.`,
        )
      } else {
        toast.success('Your account manager has been asked to top the balance up.')
      }
      setOpen(false)
      setReference('')
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={!vm.canManage}>
            {canRecord ? <Plus className="size-3.5" /> : <Send className="size-3.5" />}
            {canRecord ? 'Add funds' : 'Request funds'}
          </Button>
        }
      />
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{canRecord ? 'Add funds' : 'Request funds'}</DialogTitle>
          <DialogDescription>
            {canRecord
              ? `Record money received for ${vm.organizationName}. The balance covers each line's monthly cost and any new numbers.`
              : 'Your account manager tops the balance up. Tell them how much you need and they will take it from there.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount((preset / 100).toFixed(2))}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-sm tabular-nums transition-colors',
                  cents === preset ? 'bg-brand-soft ring-ring ring-1' : 'hover:bg-muted',
                )}
              >
                {dollars(preset)}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="funds-amount" className="text-xs font-medium">
              Amount
            </Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">$</span>
              <Input
                id="funds-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-8 w-32 tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="funds-ref" className="text-xs font-medium">
              {canRecord ? 'Reference' : 'Note'}
            </Label>
            <Input
              id="funds-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={canRecord ? 'Invoice 1042 · card ending 4242' : 'We are adding two closers next week'}
              className="h-8"
            />
            <p className="text-muted-foreground text-xs">
              {canRecord
                ? 'Shown on the ledger so the entry can be reconciled later.'
                : 'Sent along with the request.'}
            </p>
          </div>

          {error && (
            <p className="text-danger flex items-start gap-2 text-xs">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || !valid}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {canRecord ? `Add ${valid ? dollars(cents) : ''}`.trim() : 'Send request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
