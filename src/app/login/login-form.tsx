'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, ExternalLink, Loader2, MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { requestMagicLinkAction, type AuthRequestState } from '../(auth)/actions'
import { loginAction, type LoginState } from './actions'

type Mode = 'password' | 'magic'

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {pending ? busy : idle}
    </Button>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border p-3 text-sm"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function PasswordForm({ next }: { next?: string }) {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {})

  return (
    <form action={action} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}

      {state.error && <ErrorNote message={state.error} />}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={Boolean(state.fieldErrors?.email)}
          aria-describedby={state.fieldErrors?.email ? 'email-error' : undefined}
        />
        {state.fieldErrors?.email && (
          <p id="email-error" className="text-destructive text-xs">
            {state.fieldErrors.email}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot-password"
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.password)}
          aria-describedby={state.fieldErrors?.password ? 'password-error' : undefined}
        />
        {state.fieldErrors?.password && (
          <p id="password-error" className="text-destructive text-xs">
            {state.fieldErrors.password}
          </p>
        )}
      </div>

      <SubmitButton idle="Sign in" busy="Signing in…" />
    </form>
  )
}

function MagicLinkForm() {
  const [state, action] = useActionState<AuthRequestState, FormData>(requestMagicLinkAction, {})

  if (state.ok) {
    return (
      <div
        role="status"
        className="border-success/40 bg-success/10 rounded-md border p-4 text-sm motion-safe:animate-in motion-safe:fade-in"
      >
        <div className="flex items-start gap-2">
          <MailCheck className="text-success mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Check your inbox</p>
            <p className="text-muted-foreground mt-1">
              If that email has an account, a sign-in link is on its way. It works once and
              expires in 15 minutes.
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
    <form action={action} className="space-y-4">
      {state.error && <ErrorNote message={state.error} />}

      <div className="space-y-2">
        <Label htmlFor="magic-email">Email</Label>
        <Input id="magic-email" name="email" type="email" autoComplete="email" required />
        <p className="text-muted-foreground text-xs">
          We&rsquo;ll email you a one-time link that signs you in — no password needed.
        </p>
      </div>

      <SubmitButton idle="Email me a sign-in link" busy="Sending…" />
    </form>
  )
}

export function LoginForm({ next, signupEnabled = false }: { next?: string; signupEnabled?: boolean }) {
  const [mode, setMode] = useState<Mode>('password')

  return (
    <div className="mt-8 space-y-4">
      <div
        role="tablist"
        aria-label="Sign-in method"
        className="bg-muted text-muted-foreground grid grid-cols-2 gap-1 rounded-lg p-1 text-sm"
      >
        {(
          [
            ['password', 'Password'],
            ['magic', 'Email link'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              'rounded-md px-3 py-1.5 font-medium transition-colors motion-safe:duration-200',
              mode === value
                ? 'bg-background text-foreground shadow-xs'
                : 'hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        key={mode}
        className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      >
        {mode === 'password' ? <PasswordForm next={next} /> : <MagicLinkForm />}
      </div>

      {signupEnabled && (
        <p className="text-muted-foreground text-center text-sm">
          New here? <Link href="/signup" className="text-brand font-medium hover:underline">Create an account</Link>
        </p>
      )}
    </div>
  )
}
