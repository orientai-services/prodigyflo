import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'
import { landingAfterLogin } from '@/lib/staff-routes'
import { BrandMark } from '@/components/brand-mark'
import { LoginForm } from './login-form'
import { InstallAppEntry } from '@/components/pwa/install-app'
import { DemoAccounts } from './demo-accounts'

export const metadata = { title: 'Sign in' }
// This page shares the public-signup flag with /signup. Rendering at request
// time keeps the invitation link consistent with the currently active policy.
export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  // Demo credentials never render unless a deployment explicitly opts in.
  // Production and preview must set SHOW_DEMO_ACCOUNTS=false or leave it unset.
  const showDemoAccounts = process.env.SHOW_DEMO_ACCOUNTS === 'true'

  const user = await getSessionUser()
  const params = await searchParams
  const next = typeof params.next === 'string' ? params.next : undefined
  // Already signed in (an installed app reopened on this page, a second tab):
  // go where `?next=` asked when this role may open it, else home.
  if (user) redirect(landingAfterLogin(user.role, next, homeFor(user)))

  const justReset = params.reset === '1'
  const justCreated = params.created === '1'
  const signupEnabled = false

  return (
    <main className="relative grid grid-cols-1 min-h-dvh lg:grid-cols-2">
      {/* Soft brand wash behind the form — pure token color, purely decorative. */}
      <div
        aria-hidden
        className="bg-brand-soft/60 pointer-events-none absolute -top-32 -left-32 size-96 rounded-full blur-3xl"
      />

      <div className="relative flex flex-col justify-center pt-[max(3rem,calc(env(safe-area-inset-top)+1.5rem))] pr-[max(1.5rem,env(safe-area-inset-right))] pb-[max(3rem,calc(env(safe-area-inset-bottom)+1.5rem))] pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(3rem,env(safe-area-inset-right))] sm:pl-[max(3rem,env(safe-area-inset-left))] lg:px-16">
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
              <span>Your account is ready. Sign in to continue.</span>
            </div>
          )}

          <LoginForm next={next} signupEnabled={signupEnabled} />
          {/* Phones and tablets only; hidden inside the installed app. */}
          <div className="text-muted-foreground mt-8 flex justify-center lg:hidden">
            <InstallAppEntry variant="link" />
          </div>
        </div>
      </div>

      {/*
        The right column carries the demo-credentials panel only when a
        deployment opts in. Public hosts show the brand lockup instead.
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
