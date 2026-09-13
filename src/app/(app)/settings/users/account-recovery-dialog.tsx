'use client'

import { useActionState, useState } from 'react'
import { UserRoundCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  completeAccountRecoveryAction,
  inspectExistingAccountAction,
  type AccountRecoveryState,
} from './actions'

export function AccountRecoveryDialog() {
  const [open, setOpen] = useState(false)
  const [state, inspectAction, inspecting] = useActionState<AccountRecoveryState, FormData>(inspectExistingAccountAction, {})
  const [completeState, completeAction, completing] = useActionState<AccountRecoveryState, FormData>(completeAccountRecoveryAction, {})
  const error = state.error ?? completeState.error

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline"><UserRoundCheck data-slot="icon" /> Recover account</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Recover existing account</DialogTitle>
          <DialogDescription>
            Inspect an existing account before moving it. An owner account can be moved only when its legacy workspace has no other staff or live client records; its remaining workspace configuration is then deleted.
          </DialogDescription>
        </DialogHeader>
        {completeState.recoveredEmail ? (
          <div className="space-y-4 text-sm">
            <p><b>{completeState.recoveredEmail}</b> is now an Admin in this workspace.</p>
            <p className="text-muted-foreground">Recovered from {completeState.sourceOrganization}.</p>
            <div className="flex justify-end"><Button size="sm" onClick={() => setOpen(false)}>Done</Button></div>
          </div>
        ) : state.preview ? (
          <div className="space-y-4 text-sm">
            <p><b>{state.preview.email}</b> is in <b>{state.preview.sourceOrganization}</b>.</p>
            <div className="bg-surface-sunk space-y-1 rounded-md p-3 text-sm">
              <p>Workspace owner: {state.preview.isOwner ? 'yes' : 'no'}</p>
              <p>Other staff: {state.preview.otherUserCount}</p>
              <p>Client records: {state.preview.clientCount}</p>
            </div>
            {state.preview.isOwner ? (
              <p className="text-muted-foreground">
                Continuing deletes this workspace only when both counts are zero, then moves the account here as Admin.
              </p>
            ) : (
              <p className="text-muted-foreground">Continuing moves the account here as Admin. The legacy workspace remains intact.</p>
            )}
            {error && <p role="alert" className="text-danger text-sm">{error}</p>}
            <form action={completeAction} className="flex justify-end gap-2">
              <input type="hidden" name="userId" value={state.preview.userId} />
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={completing}>
                {completing ? 'Recovering…' : state.preview.isOwner ? 'Delete empty workspace & move account' : 'Move in as Admin'}
              </Button>
            </form>
          </div>
        ) : (
          <form action={inspectAction} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="recovery-email">Existing account email</Label>
              <Input id="recovery-email" name="email" type="email" required placeholder="teammate@company.com" />
            </div>
            {error && <p role="alert" className="text-danger text-sm">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={inspecting}>{inspecting ? 'Inspecting…' : 'Inspect account'}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
