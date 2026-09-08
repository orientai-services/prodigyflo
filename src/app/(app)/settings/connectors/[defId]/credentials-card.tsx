'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, KeyRound, Loader2, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CredentialFieldVM } from '@/lib/connectors/credential-logic'
import {
  deleteConnectorCredentialAction,
  rotateConnectorCredentialAction,
  saveConnectorCredentialsAction,
} from '../actions'

/**
 * The vault UI for one outbound connector. Everything here is masked-only:
 * the VM carries ••••-last4 fragments, and the inputs are write-only — a blank
 * input keeps whatever is stored. This card only renders inside
 * <StepUpGate scope="vault">, and every action it calls re-checks the grant
 * server-side (the gate is UX; the action check is the boundary).
 */
export type CredentialsCardVM = {
  defId: string
  name: string
  /** 'coming-soon' defs bank credentials but stay in mock mode. */
  staged: boolean
  /** True when every field is stored and the connector is live (CONNECTED). */
  live: boolean
  fields: CredentialFieldVM[]
}

type PendingConfirm =
  | { kind: 'rotate'; field: CredentialFieldVM; value: string }
  | { kind: 'delete'; field: CredentialFieldVM }

export function CredentialsCard({ vm }: { vm: CredentialsCardVM }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  const setDraft = (key: string, value: string) => setDrafts((d) => ({ ...d, [key]: value }))

  const finish = (ok: boolean, message: string) => {
    if (ok) {
      toast.success(message)
      router.refresh()
    } else {
      toast.error(message)
    }
  }

  const saveNew = (field: CredentialFieldVM) => {
    const value = (drafts[field.key] ?? '').trim()
    if (!value) return
    startTransition(async () => {
      const res = await saveConnectorCredentialsAction({ defId: vm.defId, values: { [field.key]: value } })
      if (res.ok) setDraft(field.key, '')
      finish(res.ok, res.ok ? `${field.label} saved.` : res.error || 'Could not save.')
    })
  }

  const confirmRotate = () => {
    if (!confirm || confirm.kind !== 'rotate') return
    const { field, value } = confirm
    startTransition(async () => {
      const res = await rotateConnectorCredentialAction({ defId: vm.defId, fieldKey: field.key, value })
      if (res.ok) setDraft(field.key, '')
      setConfirm(null)
      finish(res.ok, res.ok ? `${field.label} replaced.` : res.error || 'Could not rotate.')
    })
  }

  const confirmDelete = () => {
    if (!confirm || confirm.kind !== 'delete') return
    const { field } = confirm
    startTransition(async () => {
      const res = await deleteConnectorCredentialAction({ defId: vm.defId, fieldKey: field.key })
      setConfirm(null)
      finish(res.ok, res.ok ? `${field.label} removed.` : res.error || 'Could not remove.')
    })
  }

  const submitField = (field: CredentialFieldVM) => {
    const value = (drafts[field.key] ?? '').trim()
    if (!value) return
    if (field.configured) {
      setConfirm({ kind: 'rotate', field, value })
    } else {
      saveNew(field)
    }
  }

  const configuredCount = vm.fields.filter((f) => f.configured).length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Credentials
          </span>
          <span className="text-muted-foreground text-xs font-medium tabular-nums">
            {configuredCount}/{vm.fields.length} set
          </span>
        </CardTitle>
        <CardDescription>
          Stored encrypted, write-only — values can be replaced or removed, never read back. Leave a field blank
          to keep what is stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {vm.staged ? (
          <div className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              This connector&apos;s live adapter has not shipped yet. Credentials you store now are held securely
              and it stays in mock mode until the adapter lands.
            </span>
          </div>
        ) : vm.live ? (
          <div className="border-success/40 bg-success/10 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>All credential fields are set — {vm.name} is connected and live.</span>
          </div>
        ) : (
          <div className="border-warning/40 bg-warning/10 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>Running in mock mode. Store every field below to flip {vm.name} live.</span>
          </div>
        )}

        <div className="divide-border divide-y">
          {vm.fields.map((field) => {
            const draft = drafts[field.key] ?? ''
            return (
              <div key={field.key} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`cred-${vm.defId}-${field.key}`} className="text-xs font-medium">
                    {field.label}
                  </Label>
                  {field.configured ? (
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                      <code className="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-[0.6875rem]">
                        {field.masked}
                      </code>
                      {field.updatedLabel && <span>updated {field.updatedLabel}</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs italic">Not set</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    id={`cred-${vm.defId}-${field.key}`}
                    type={field.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={draft}
                    onChange={(e) => setDraft(field.key, e.target.value)}
                    placeholder={
                      field.configured ? 'Enter a new value to replace' : (field.placeholder ?? undefined)
                    }
                    className="h-8 flex-1 font-mono text-xs"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitField(field)
                    }}
                  />
                  <Button
                    size="sm"
                    variant={field.configured ? 'outline' : 'default'}
                    disabled={pending || !draft.trim()}
                    onClick={() => submitField(field)}
                  >
                    {field.configured ? <RefreshCw className="size-3.5" /> : <Save className="size-3.5" />}
                    {field.configured ? 'Replace' : 'Save'}
                  </Button>
                  {field.configured && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Remove ${field.label}`}
                      disabled={pending}
                      onClick={() => setConfirm({ kind: 'delete', field })}
                    >
                      <Trash2 className="text-danger size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>

      {/* ── Rotate / delete confirm ── */}
      <Dialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <DialogContent className="max-w-md">
          {confirm?.kind === 'rotate' ? (
            <>
              <DialogHeader>
                <DialogTitle>Replace {confirm.field.label}?</DialogTitle>
                <DialogDescription>
                  The stored value ({confirm.field.masked}) is overwritten immediately and cannot be recovered.
                  Live calls switch to the new value on their next use.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setConfirm(null)} disabled={pending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={confirmRotate} disabled={pending}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  Replace value
                </Button>
              </DialogFooter>
            </>
          ) : confirm?.kind === 'delete' ? (
            <>
              <DialogHeader>
                <DialogTitle>Remove {confirm.field.label}?</DialogTitle>
                <DialogDescription>
                  The stored value ({confirm.field.masked}) is deleted permanently. If this connector is live,
                  it drops back to mock mode until the field is stored again.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setConfirm(null)} disabled={pending}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={confirmDelete} disabled={pending}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  Remove
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
