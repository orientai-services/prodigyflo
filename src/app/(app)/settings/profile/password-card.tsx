'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { KeyRound, Loader2, MailQuestion } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  changePasswordAction,
  sendResetLinkAction,
  type PasswordState,
  type ResetLinkState,
} from './actions'

function Field({
  id,
  name,
  label,
  autoComplete,
  minLength,
  error,
}: {
  id: string
  name: string
  label: string
  autoComplete: string
  minLength?: number
  error?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type="password"
        autoComplete={autoComplete}
        minLength={minLength}
        required
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Two ways to a new password: prove the current one right here, or — when it
 * is forgotten — mail a single-use reset link to the account's own inbox.
 * On a keyless dev install the mail channel is mock, so the card says so and
 * surfaces the dev link the server logs.
 */
export function PasswordCard({
  minLength,
  emailMock,
  maskedEmail,
}: {
  minLength: number
  emailMock: boolean
  maskedEmail: string
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [state, action, pending] = useActionState<PasswordState, FormData>(changePasswordAction, {})
  const [reset, setReset] = useState<ResetLinkState | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (state.ok) {
      toast.success(state.ok)
      formRef.current?.reset()
    }
    if (state.error) toast.error(state.error)
  }, [state])

  const sendLink = async () => {
    setSending(true)
    try {
      const result = await sendResetLinkAction()
      setReset(result)
      if (result.ok) toast.success(result.ok)
      if (result.error) toast.error(result.error)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5">
        <form ref={formRef} action={action} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="bg-brand-soft text-brand grid size-9 shrink-0 place-items-center rounded-lg">
                <KeyRound className="size-4.5" />
              </div>
              <div>
                <h2 className="font-semibold">Password &amp; sign-in</h2>
                <p className="text-muted-foreground text-xs">
                  Changing it signs old reset and magic-link emails out of existence.
                </p>
              </div>
            </div>
            {emailMock && (
              <Badge variant="outline" title="No email service is configured — reset links are logged on the server instead of delivered.">
                email: mock
              </Badge>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              id="pw-current"
              name="currentPassword"
              label="Current password"
              autoComplete="current-password"
              error={state.fieldErrors?.currentPassword}
            />
            <Field
              id="pw-new"
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              minLength={minLength}
              error={state.fieldErrors?.newPassword}
            />
            <Field
              id="pw-confirm"
              name="confirm"
              label="Confirm new password"
              autoComplete="new-password"
              minLength={minLength}
              error={state.fieldErrors?.confirm}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">At least {minLength} characters.</p>
            <Button type="submit" size="sm" disabled={pending}>
              {pending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {pending ? 'Changing…' : 'Change password'}
            </Button>
          </div>
        </form>

        <div className="border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <MailQuestion className="text-muted-foreground size-4" />
              <span className="text-muted-foreground">
                Don&apos;t know your current password? Get a single-use reset link at {maskedEmail}.
              </span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void sendLink()} disabled={sending}>
              {sending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {sending ? 'Sending…' : 'Send reset link'}
            </Button>
          </div>
          {reset?.ok && (
            <p className="text-muted-foreground mt-2 text-xs" role="status">
              {reset.ok}
              {reset.devLink && (
                <>
                  {' '}
                  Mock mail —{' '}
                  <Link href={reset.devLink} className="text-brand font-medium hover:underline">
                    open the reset link
                  </Link>
                  .
                </>
              )}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
