'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, ExternalLink, Loader2, MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { requestPasswordResetAction, type AuthRequestState } from '../actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  )
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState<AuthRequestState, FormData>(requestPasswordResetAction, {})

  if (state.ok) {
    return (
      <div
        role="status"
        className="border-success/40 bg-success/10 mt-8 rounded-md border p-4 text-sm motion-safe:animate-in motion-safe:fade-in"
      >
        <div className="flex items-start gap-2">
          <MailCheck className="text-success mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Check your inbox</p>
            <p className="text-muted-foreground mt-1">
              If that email has an account, a reset link is on its way. It works once and expires
              in 30 minutes.
            </p>
            {state.devLink && (
              <a
                href={state.devLink}
                className="text-brand mt-2 inline-flex items-center gap-1 text-xs font-medium hover:underline"
              >
                <ExternalLink className="size-3" />
                Open dev link (mock mail mode)
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <form action={action} className="mt-8 space-y-4">
      {state.error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" autoFocus required />
      </div>

      <SubmitButton />
    </form>
  )
}
