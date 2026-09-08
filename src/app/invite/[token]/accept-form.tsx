'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { acceptInviteAction, type AcceptState } from './actions'

export function AcceptForm({ token, askEmail = false }: { token: string; askEmail?: boolean }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(
    acceptInviteAction.bind(null, token),
    {},
  )

  const field = (name: string) => state.fieldErrors?.[name]

  return (
    <form action={action} className="mt-6 space-y-4">
      {askEmail && (
        <div className="space-y-1.5">
          <Label htmlFor="inv-acc-email">Your email</Label>
          <Input id="inv-acc-email" name="email" type="email" autoComplete="email" required />
          {field('email') && <p className="text-danger text-xs">{field('email')}</p>}
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="name">Full name</Label>
        <Input id="name" name="name" autoComplete="name" required />
        {field('name') && <p className="text-danger text-xs">{field('name')}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        {field('password') && <p className="text-danger text-xs">{field('password')}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        {field('confirm') && <p className="text-danger text-xs">{field('confirm')}</p>}
      </div>
      {state.error && <p className="text-danger text-sm">{state.error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
