import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'
import { BrandMark } from '@/components/brand-mark'
import { LoginForm } from './login-form'
import { DemoAccounts } from './demo-accounts'

export const metadata = { title: 'Sign in' }

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  // The panel prints real sign-in credentials, so it never renders on a public
  // deployment. Opt out by setting SHOW_DEMO_ACCOUNTS=false in the environment.
  const showDemoAccounts = process.env.SHOW_DEMO_ACCOUNTS !== 'false'

  const user = await getSessionUser()
  if (user) redirect(homeFor(user))

  const params = await searchParams
  const next = typeof params.next === 'string' ? params.next : undefined
  const justReset = params.reset === '1'
  const justCreated = params.created === '1'
  const signupEnabled = process.env.ALLOW_SELF_SIGNUP === 'true'

  return (
    <main className="relative grid min-h-dvh lg:grid-cols-2">
      {/* Soft brand wash behind the form — pure token color, purely decorative. */}
      <div
        aria-hidden
        className="bg-brand-soft/60 pointer-events-none absolute -top-32 -left-32 size-96 rounded-full blur-3xl"
      />

      <div className="relative flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <BrandMark className="h-8" />
          <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Client operations from first survey to final submission.
          </p>

          {justReset && (
            <div
              role="status"
              className="border-success/40 bg-success/10 mt-6 flex items-start gap-2 rounded-md border p-3 text-sm motion-safe:animate-in motion-safe:fade-in"
            >
              <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
              <span>Your password has been reset. Sign in with the new one.</span>
            </div>
          )}

          {justCreated && (
            <div
              role="status"
              className="border-success/40 bg-success/10 mt-6 flex items-start gap-2 rounded-md border p-3 text-sm motion-safe:animate-in motion-safe:fade-in"
            >
              <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
              <span>Your admin account is ready. Sign in to continue.</span>
            </div>
          )}

          <LoginForm next={next} signupEnabled={signupEnabled} />
        </div>
      </div>

      {/*
        The right column carries the demo-credentials panel in development. On a
        public deployment SHOW_DEMO_ACCOUNTS is false and that half of the page
        was simply blank — so it now carries the full lockup instead. This is the
        one place the tagline belongs: a full-bleed brand surface with room for
        it, rather than the 14px app chrome.
      */}
      <aside className="bg-sidebar hidden border-l lg:flex lg:flex-col lg:justify-center lg:px-16">
        <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700">
          {showDemoAccounts ? (
            <DemoAccounts />
          ) : (
            <BrandMark tagline className="w-full max-w-sm" />
          )}
        </div>
      </aside>
    </main>
  )
}
