'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { resetPasswordAction, type ResetPasswordState } from '../actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {pending ? 'Saving…' : 'Set new password'}
    </Button>
  )
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState<ResetPasswordState, FormData>(resetPasswordAction, {})

  return (
    <form action={action} className="mt-8 space-y-4">
      <input type="hidden" name="token" value={token} />

      {state.error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </div>
          <Link
            href="/forgot-password"
            className="mt-2 ml-6 inline-block font-medium hover:underline"
          >
            Request a new reset link
          </Link>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          autoFocus
          aria-invalid={Boolean(state.fieldErrors?.password)}
          aria-describedby={state.fieldErrors?.password ? 'password-error' : undefined}
        />
        {state.fieldErrors?.password && (
          <p id="password-error" className="text-destructive text-xs">
            {state.fieldErrors.password}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          aria-invalid={Boolean(state.fieldErrors?.confirm)}
          aria-describedby={state.fieldErrors?.confirm ? 'confirm-error' : undefined}
        />
        {state.fieldErrors?.confirm && (
          <p id="confirm-error" className="text-destructive text-xs">
            {state.fieldErrors.confirm}
          </p>
        )}
      </div>

      <SubmitButton />
    </form>
  )
}
