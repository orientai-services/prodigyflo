'use client'

// Interactive islands for the CYS readiness tab. They live under src/lib/cys
// so the tab itself (src/components/client/cys-tab.tsx) can stay a pure server
// component owned by the cross-slice contract.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Loader2, PackageCheck, Pencil, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/ui/native-select'
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
  approveCysReadinessAction,
  generateCysPackageAction,
  verifyCysFieldAction,
  type CysActionResult,
} from '@/lib/cys/actions'

function useAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const run = (fn: () => Promise<CysActionResult>, onDone?: (r: CysActionResult) => void) => {
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        if (result.message) toast.success(result.message)
        router.refresh()
      } else if (!onDone) {
        toast.error(result.error, {
          description: result.blockers?.length ? result.blockers.join(' ') : undefined,
        })
      }
      onDone?.(result)
    })
  }
  return { pending, run }
}

export function FieldActions({
  clientId,
  fieldKey,
  label,
  status,
  value,
  conflictValue,
  dataType,
}: {
  clientId: string
  fieldKey: string
  label: string
  status: 'MISSING' | 'SUGGESTED' | 'VERIFIED' | 'CONFLICT'
  value: string | null
  conflictValue: string | null
  dataType: string
}) {
  const { pending, run } = useAction()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = (v: string) => {
    setError(null)
    run(
      () => verifyCysFieldAction({ clientId, fieldKey, value: v }),
      (result) => {
        if (result.ok) {
          toast.success(`"${label}" verified.`)
          setEditing(false)
        } else {
          setError(result.fieldErrors?.value ?? result.error)
        }
      },
    )
  }

  if (editing) {
    return (
      <form
        className="flex flex-wrap items-center justify-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          save(draft)
        }}
      >
        {dataType === 'boolean' ? (
          <NativeSelect
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Value for ${label}`}
            className="border-input bg-background h-7 rounded-md border px-2 text-xs outline-none"
          >
            <option value="">Choose…</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </NativeSelect>
        ) : (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`Value for ${label}`}
            className="h-7 w-44 text-xs"
            autoFocus
          />
        )}
        <Button type="submit" size="icon-sm" disabled={pending} aria-label="Save value">
          {pending ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => {
            setEditing(false)
            setError(null)
          }}
          aria-label="Cancel"
        >
          <X />
        </Button>
        {error && <p className="text-destructive w-full text-right text-xs">{error}</p>}
      </form>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {status === 'CONFLICT' && value && conflictValue ? (
        <>
          <Button size="xs" variant="outline" disabled={pending} onClick={() => save(value)}>
            Use “{value}”
          </Button>
          <Button size="xs" variant="outline" disabled={pending} onClick={() => save(conflictValue)}>
            Use “{conflictValue}”
          </Button>
        </>
      ) : status === 'SUGGESTED' && value ? (
        <Button size="xs" variant="outline" disabled={pending} onClick={() => save(value)}>
          {pending ? <Loader2 className="animate-spin" /> : <Check />}
          Verify
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setDraft(value ?? '')
          setEditing(true)
        }}
      >
        <Pencil />
        {status === 'MISSING' ? 'Enter' : 'Correct'}
      </Button>
    </div>
  )
}

export function ApproveReadinessDialog({
  clientId,
  blockers,
}: {
  clientId: string
  blockers: string[]
}) {
  const { pending, run } = useAction()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [result, setResult] = useState<CysActionResult | null>(null)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <ShieldCheck />
        Approve as CYS ready
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve as CYS ready</DialogTitle>
          <DialogDescription>
            Approval locks in the verified field set, advances the client to “Deal ready for
            submission”, and unlocks package generation. The server refuses approval while any
            required field is missing, conflicting, or unverified.
          </DialogDescription>
        </DialogHeader>
        {blockers.length > 0 && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs">
            <p className="font-medium">Currently blocked:</p>
            <ul className="mt-1 list-disc pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Approval note (optional)"
          rows={3}
        />
        {result && !result.ok && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs">
            <p className="font-medium">{result.error}</p>
            {result.blockers && (
              <ul className="mt-1 list-disc pl-4">
                {result.blockers.map((b) => (
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
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              setResult(null)
              run(
                () => approveCysReadinessAction({ clientId, note: note || undefined }),
                (r) => {
                  setResult(r)
                  if (r.ok) {
                    toast.success('Client approved as CYS ready.')
                    setOpen(false)
                  }
                },
              )
            }}
          >
            {pending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GeneratePackageButton({
  clientId,
  regenerate,
}: {
  clientId: string
  regenerate: boolean
}) {
  const { pending, run } = useAction()
  return (
    <Button
      size="sm"
      variant={regenerate ? 'outline' : 'default'}
      disabled={pending}
      onClick={() => run(() => generateCysPackageAction({ clientId }))}
    >
      {pending ? <Loader2 className="animate-spin" /> : <PackageCheck />}
      {regenerate ? 'Regenerate package' : 'Generate package'}
    </Button>
  )
}
