'use client'

import { useActionState, useState } from 'react'
import { Check, Copy, UserPlus } from 'lucide-react'
import type { RoleKey } from '@prisma/client'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { createInviteAction, type InviteState } from './actions'

const ROLE_NAMES: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin / Operations', REGIONAL_MANAGER: 'Regional Manager',
  SALES_MANAGER: 'Sales Manager', CLOSER: 'Closer', DOCUMENT_COLLECTOR: 'Document Collector', MARKETING: 'Marketing',
}

export function InviteDialog({ roles, teams }: { roles: RoleKey[]; teams: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'email' | 'link'>('email')
  const [state, action, pending] = useActionState<InviteState, FormData>(createInviteAction, {})
  const [copied, setCopied] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm"><UserPlus data-slot="icon" /> Invite user</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>
            They set their own name and password from the link. Links expire after 7 days.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-surface-sunk grid grid-cols-2 gap-1 rounded-lg p-1 text-sm">
          {([['email', 'By email'], ['link', 'By link']] as const).map(([m, label]) => (
            <button
              key={m} type="button" onClick={() => setMode(m)}
              className={`rounded-md py-1.5 font-medium transition-colors ${
                mode === m ? 'bg-surface-raised shadow-e1' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {state.inviteUrl ? (
          <div className="space-y-3">
            <p className="text-sm">
              {state.email ? (
                <>Invite created for <b>{state.email}</b>.</>
              ) : (
                <>Single-use link created — <b>whoever opens it first</b> joins with the chosen role.</>
              )}{' '}
              Share it — for security it is shown only once (you can reset it later from the
              pending list):
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={state.inviteUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button
                type="button" size="sm" variant="outline"
                onClick={async () => { await navigator.clipboard.writeText(state.inviteUrl!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              >
                {copied ? <Check data-slot="icon" /> : <Copy data-slot="icon" />}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Email delivery runs in mock mode, so send the link yourself (text, Slack, etc.).
            </p>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="mode" value={mode} />
            {mode === 'email' ? (
              <div className="space-y-1.5">
                <Label htmlFor="inv-email">Email</Label>
                <Input id="inv-email" name="email" type="email" required placeholder="teammate@company.com" />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No email needed — the link works once, expires in 7 days, and the person who opens
                it enters their own email. Best for someone standing next to you or on a call.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="inv-role">Role</Label>
              <NativeSelect id="inv-role" name="roleKey" defaultValue="ADMIN" className="w-full">
                {roles.map((r) => <option key={r} value={r}>{ROLE_NAMES[r] ?? r}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-team">Team (optional)</Label>
              <NativeSelect id="inv-team" name="teamId" className="w-full">
                <option value="">No team</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </NativeSelect>
            </div>
            {state.error && <p className="text-danger text-sm">{state.error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create invite'}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
