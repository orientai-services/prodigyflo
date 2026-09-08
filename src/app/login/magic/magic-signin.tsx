'use client'

import Link from 'next/link'
import { useActionState, useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { completeMagicSignInAction, type MagicSignInState } from './actions'

function FallbackButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {pending ? 'Signing you in…' : 'Sign in'}
    </Button>
  )
}

/**
 * Auto-submits the single-use token the moment the page mounts, so clicking
 * the emailed link is normally the whole ceremony. The visible form doubles as
 * the no-auto-fire fallback; the ref guards Strict Mode's double effect from
 * burning the token twice.
 */
export function MagicSignIn({ token }: { token: string }) {
  const [state, action] = useActionState<MagicSignInState, FormData>(completeMagicSignInAction, {})
  const formRef = useRef<HTMLFormElement>(null)
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current || state.error) return
    fired.current = true
    formRef.current?.requestSubmit()
  }, [state.error])

  if (state.error) {
    return (
      <div
        role="alert"
        className="border-destructive/40 bg-destructive/10 mt-8 rounded-md border p-4 text-sm motion-safe:animate-in motion-safe:fade-in"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
          <p className="text-destructive">{state.error}</p>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Button className="w-full" render={<Link href="/login" />}>
            Back to sign in
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form ref={formRef} action={action} className="mt-8">
      <input type="hidden" name="token" value={token} />

      <div
        role="status"
        className="bg-card flex items-center gap-3 rounded-md border p-4 text-sm shadow-xs"
      >
        <span className="bg-brand-soft flex size-9 shrink-0 items-center justify-center rounded-full">
          <Sparkles className="text-brand size-4" />
        </span>
        <div>
          <p className="font-medium">Checking your sign-in link…</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            You&rsquo;ll be redirected in a moment.
          </p>
        </div>
        <Loader2 className="text-muted-foreground ml-auto size-4 animate-spin" />
      </div>

      {/* Fallback when the auto-submit did not fire (JS partially loaded). */}
      <div className="mt-4">
        <FallbackButton />
      </div>
    </form>
  )
}
