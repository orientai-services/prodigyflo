'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { signupAction, type SignupState } from './actions'

const initialState: SignupState = {}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-destructive text-xs">{message}</p> : null
}

export function SignupForm() {
  const [state, action, pending] = useActionState(signupAction, initialState)

  return (
    <form action={action} className="mt-8 space-y-4">
      {state.error && <p role="alert" className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">{state.error}</p>}
      <div className="space-y-2">
        <Label htmlFor="name">Your full name</Label>
        <Input id="name" name="name" autoComplete="name" required aria-invalid={Boolean(state.fieldErrors?.name)} />
        <FieldError message={state.fieldErrors?.name} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(state.fieldErrors?.email)} />
        <FieldError message={state.fieldErrors?.email} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required aria-invalid={Boolean(state.fieldErrors?.password)} />
        <p className="text-muted-foreground text-xs">Use at least 10 characters.</p>
        <FieldError message={state.fieldErrors?.password} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="passwordConfirmation">Confirm password</Label>
        <Input id="passwordConfirmation" name="passwordConfirmation" type="password" autoComplete="new-password" required aria-invalid={Boolean(state.fieldErrors?.passwordConfirmation)} />
        <FieldError message={state.fieldErrors?.passwordConfirmation} />
      </div>
      <div className="sr-only" aria-hidden="true">
        <Label htmlFor="website">Website</Label>
        <Input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending && <Loader2 className="size-4 animate-spin" />}
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-muted-foreground text-center text-sm">
        Already have an account? <Link href="/login" className="text-brand font-medium hover:underline">Sign in</Link>
      </p>
    </form>
  )
}
