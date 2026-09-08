'use client'

import { useActionState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PasswordStepUpScope } from '@/lib/stepup'
import { confirmPasswordAction, type StepUpState } from './actions'

const SCOPE_COPY: Record<PasswordStepUpScope, { title: string; description: string }> = {
  vault: {
    title: 'Confirm your password',
    description:
      'Connector credentials are sensitive. Re-enter your password to unlock this area for the next 10 minutes.',
  },
  deploy: {
    title: 'Confirm your password',
    description:
      'Deploying changes production. Re-enter your password to unlock the deploy console for the next 10 minutes.',
  },
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {pending ? 'Confirming…' : 'Confirm'}
    </Button>
  )
}

/**
 * The locked face of <StepUpGate>: a centered card in the forbidden-page
 * visual language with a single password field. On success the server action
 * sets the grant cookie, so a router.refresh() re-runs the gate's server
 * probe and the protected content takes this card's place.
 */
export function StepUpPrompt({ scope }: { scope: PasswordStepUpScope }) {
  const router = useRouter()
  const [state, action] = useActionState<StepUpState, FormData>(confirmPasswordAction, {})
  const copy = SCOPE_COPY[scope]

  useEffect(() => {
    if (state.granted) router.refresh()
  }, [state.granted, router])

  return (
    <Card>
      <CardContent className="flex justify-center py-10">
        <div className="w-full max-w-sm text-center">
          <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
            <ShieldAlert className="text-muted-foreground size-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">{copy.title}</h2>
          <p className="text-muted-foreground mt-2 text-sm">{copy.description}</p>

          <form action={action} className="mt-6 space-y-4 text-left">
            <input type="hidden" name="scope" value={scope} />

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
              <Label htmlFor="stepup-password">Password</Label>
              <Input
                id="stepup-password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
              />
            </div>

            <SubmitButton />
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
