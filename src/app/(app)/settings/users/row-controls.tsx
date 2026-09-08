'use client'

import { useActionState, useState } from 'react'
import { Check, Copy, Link2, XCircle } from 'lucide-react'
import type { RoleKey } from '@prisma/client'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import {
  changeRoleAction, resetInviteAction, revokeInviteAction, setUserActiveAction,
  type InviteState, type UserActionState,
} from './actions'

const ROLE_NAMES: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin / Operations', REGIONAL_MANAGER: 'Regional Manager',
  SALES_MANAGER: 'Sales Manager', CLOSER: 'Closer', DOCUMENT_COLLECTOR: 'Document Collector', MARKETING: 'Marketing',
}

export function UserRowControls({
  userId, currentRole, isActive, roles,
}: { userId: string; currentRole: RoleKey; isActive: boolean; roles: RoleKey[] }) {
  const [roleState, roleAction] = useActionState<UserActionState, FormData>(changeRoleAction, {})
  const [activeState, activeAction, activePending] = useActionState<UserActionState, FormData>(setUserActiveAction, {})
  const error = roleState.error ?? activeState.error

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-danger max-w-48 truncate text-xs" title={error}>{error}</span>}
      <form
        action={roleAction}
        onChange={(e) => (e.currentTarget as HTMLFormElement).requestSubmit()}
      >
        <input type="hidden" name="userId" value={userId} />
        <NativeSelect name="roleKey" size="sm" defaultValue={currentRole} aria-label="Change role">
          {/* The current role stays listed even when it outranks the actor, so the
              control shows the truth; the server refuses ungrantable choices. */}
          {[...new Set([currentRole, ...roles])].map((r) => (
            <option key={r} value={r}>{ROLE_NAMES[r] ?? r}</option>
          ))}
        </NativeSelect>
      </form>
      <form action={activeAction}>
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="active" value={isActive ? 'false' : 'true'} />
        <Button type="submit" size="sm" variant={isActive ? 'outline' : 'default'} disabled={activePending}>
          {isActive ? 'Deactivate' : 'Reactivate'}
        </Button>
      </form>
    </div>
  )
}

export function InviteRowActions({ inviteId }: { inviteId: string }) {
  const [state, resetAction, pending] = useActionState<InviteState, FormData>(resetInviteAction, {})
  const [copied, setCopied] = useState(false)

  return (
    <div className="flex items-center justify-end gap-2">
      {state.inviteUrl ? (
        <Button
          type="button" size="sm" variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(state.inviteUrl!)
            setCopied(true); toast.success('Invite link copied')
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check data-slot="icon" /> : <Copy data-slot="icon" />} Copy new link
        </Button>
      ) : (
        <form action={resetAction}>
          <input type="hidden" name="inviteId" value={inviteId} />
          <Button type="submit" size="sm" variant="outline" disabled={pending} title="Generate a fresh link (the old one stops working)">
            <Link2 data-slot="icon" /> Reset link
          </Button>
        </form>
      )}
      <form action={revokeInviteAction}>
        <input type="hidden" name="inviteId" value={inviteId} />
        <Button type="submit" size="sm" variant="ghost" title="Revoke this invite">
          <XCircle data-slot="icon" />
        </Button>
      </form>
      {state.error && <span className="text-danger text-xs">{state.error}</span>}
    </div>
  )
}
