'use client'

import { useActionState, useState } from 'react'
import { UserRoundCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { recoverExistingAccountAction, type AccountRecoveryState } from './actions'

export function AccountRecoveryDialog() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<AccountRecoveryState, FormData>(recoverExistingAccountAction, {})

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline"><UserRoundCheck data-slot="icon" /> Recover account</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Recover existing account</DialogTitle>
          <DialogDescription>
            Moves a non-owner account from another workspace into this workspace as Admin. Accounts that own a workspace are blocked to protect its data.
          </DialogDescription>
        </DialogHeader>
        {state.recoveredEmail ? (
          <div className="space-y-4 text-sm">
            <p><b>{state.recoveredEmail}</b> is now an Admin in this workspace.</p>
            <p className="text-muted-foreground">Moved from {state.sourceOrganization}.</p>
            <div className="flex justify-end"><Button size="sm" onClick={() => setOpen(false)}>Done</Button></div>
          </div>
        ) : (
          <form action={action} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="recovery-email">Existing account email</Label>
              <Input id="recovery-email" name="email" type="email" required placeholder="teammate@company.com" />
            </div>
            {state.error && <p role="alert" className="text-danger text-sm">{state.error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={pending}>{pending ? 'Recovering…' : 'Move in as Admin'}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
