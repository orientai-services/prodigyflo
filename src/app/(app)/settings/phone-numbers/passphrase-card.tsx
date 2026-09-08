'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Lock, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { confirmPasswordAction, type StepUpState } from '@/components/stepup/actions'
import {
  clearProvisioningPassphraseAction,
  setProvisioningPassphraseAction,
} from './actions'
import type { ConsoleVM } from './types'

/**
 * The owner's control over the passphrase that authorises putting a number on
 * the agency card.
 *
 * This exists so turning the money gate on never requires a shell on the
 * server. Setting it here stores a bcrypt hash, encrypted at rest with the
 * vault key, on the agency organization — and takes precedence over any
 * server environment variable, so a rotation is immediate.
 *
 * Two locks, both enforced server-side: only the true owner sees or can use
 * this card, and they must re-enter their OWN password first — the same
 * ten-minute 'vault' confirmation that guards connector credentials. That
 * password is a different thing from the passphrase being set, which is the
 * whole point: one proves who you are, the other authorises spending.
 */
export function PassphraseCard({ vm }: { vm: ConsoleVM }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [unlocked, setUnlocked] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const fromEnv = vm.passphraseSource === 'env'
  const tooShort = passphrase.length > 0 && passphrase.length < 8
  const mismatch = confirm.length > 0 && passphrase !== confirm
  const canSave = passphrase.length >= 8 && passphrase === confirm

  const save = () => {
    setError(null)
    startTransition(async () => {
      const res = await setProvisioningPassphraseAction({ passphrase, confirm })
      if (!res.ok) {
        if (res.code === 'STEP_UP_REQUIRED') setUnlocked(false)
        setError(res.error)
        return
      }
      toast.success('Provisioning passphrase saved.')
      setPassphrase('')
      setConfirm('')
      setOpen(false)
      router.refresh()
    })
  }

  const clear = () => {
    setError(null)
    startTransition(async () => {
      const res = await clearProvisioningPassphraseAction()
      setConfirmClear(false)
      if (!res.ok) {
        if (res.code === 'STEP_UP_REQUIRED') setUnlocked(false)
        toast.error(res.error)
        return
      }
      toast.success('Provisioning passphrase removed.')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" />
          Provisioning passphrase
        </CardTitle>
        <CardDescription>
          Asked for before any number is charged to the agency card. Only you can set it, and it is never shown
          again once saved.
        </CardDescription>
        <CardAction>
          {vm.passphraseConfigured ? (
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="text-success size-3" />
              {fromEnv ? 'Set on the server' : 'Set'}
            </Badge>
          ) : (
            <Badge variant="destructive">Not set</Badge>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {!vm.passphraseConfigured && (
          <p className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              Until this is set, the internal accounts cannot buy a number at all — there is no way to authorise
              the charge. Everything else on this page works as normal.
            </span>
          </p>
        )}

        {fromEnv && (
          <p className="text-muted-foreground text-xs">
            The current passphrase comes from a server environment variable. Setting one here replaces it
            everywhere and takes effect immediately — after that it can be rotated from this page alone.
          </p>
        )}

        {unlocked ? (
          <Button size="sm" onClick={() => setOpen(true)} disabled={pending}>
            <KeyRound className="size-3.5" />
            {vm.passphraseConfigured ? 'Replace passphrase' : 'Set passphrase'}
          </Button>
        ) : (
          <VaultUnlock onUnlocked={() => setUnlocked(true)} />
        )}

        {unlocked && vm.passphraseConfigured && !fromEnv && (
          <Button size="sm" variant="outline" onClick={() => setConfirmClear(true)} disabled={pending}>
            <Trash2 className="text-danger size-3.5" />
            Remove it
          </Button>
        )}
      </CardContent>

      {/* ── Set / replace ── */}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) {
            setPassphrase('')
            setConfirm('')
            setError(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{vm.passphraseConfigured ? 'Replace the passphrase' : 'Set the passphrase'}</DialogTitle>
            <DialogDescription>
              Anyone buying a number for an internal account will be asked for this. Choose something you can pass
              on to whoever provisions lines — and nobody else.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pp-new" className="text-xs font-medium">
                New passphrase
              </Label>
              <Input
                id="pp-new"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="h-8"
              />
              {tooShort && <p className="text-muted-foreground text-xs">At least 8 characters.</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pp-confirm" className="text-xs font-medium">
                Type it again
              </Label>
              <Input
                id="pp-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave) save()
                }}
              />
              {mismatch && <p className="text-danger text-xs">The two entries do not match.</p>}
            </div>

            {vm.passphraseConfigured && (
              <p className="text-muted-foreground text-xs">
                The current passphrase stops working the moment this is saved. Anyone mid-purchase will be asked
                for the new one.
              </p>
            )}

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
            <Button size="sm" onClick={save} disabled={pending || !canSave}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Remove ── */}
      <Dialog open={confirmClear} onOpenChange={(v) => !v && setConfirmClear(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove the passphrase?</DialogTitle>
            <DialogDescription>
              Internal accounts will not be able to buy numbers until a passphrase exists again. Nothing already
              bought is affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)} disabled={pending}>
              Keep it
            </Button>
            <Button variant="destructive" size="sm" onClick={clear} disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function UnlockSubmit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant="outline" disabled={pending}>
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Lock className="size-3.5" />}
      Confirm
    </Button>
  )
}

/**
 * Your own password, not the passphrase. Reuses the same server action and
 * ten-minute 'vault' grant as the connector credential vault, so confirming
 * here also unlocks that — and the actions re-check the grant regardless of
 * what this component believes.
 */
function VaultUnlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [state, action] = useActionState<StepUpState, FormData>(confirmPasswordAction, {})

  useEffect(() => {
    if (state.granted) onUnlocked()
  }, [state.granted, onUnlocked])

  return (
    <form action={action} className="space-y-2 rounded-md border p-3">
      <input type="hidden" name="scope" value="vault" />
      <p className="text-muted-foreground text-xs">
        Confirm your own password to manage this, the same way the credential vault asks.
      </p>
      <div className="flex items-center gap-2">
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Your password"
          className="h-8 flex-1"
        />
        <UnlockSubmit />
      </div>
      {state.error && (
        <p className="text-danger flex items-start gap-2 text-xs">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {state.error}
        </p>
      )}
    </form>
  )
}
