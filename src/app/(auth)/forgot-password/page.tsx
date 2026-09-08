import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'
import { BrandMark } from '@/components/brand-mark'
import { ForgotPasswordForm } from './forgot-form'

export const metadata = { title: 'Reset your password' }

export default async function ForgotPasswordPage() {
  const user = await getSessionUser()
  if (user) redirect(homeFor(user))

  return (
    <main className="relative grid min-h-dvh place-items-center px-6 py-12">
      {/* Same decorative brand wash as the login page — one visual family. */}
      <div
        aria-hidden
        className="bg-brand-soft/60 pointer-events-none absolute -top-32 -left-32 size-96 rounded-full blur-3xl"
      />

      <div className="relative w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <BrandMark className="h-8" />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter your email and we&rsquo;ll send a one-time link to choose a new password.
        </p>

        <ForgotPasswordForm />

        <Link
          href="/login"
          className="text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </Link>
      </div>
    </main>
  )
}
