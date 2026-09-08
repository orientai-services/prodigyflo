import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'
import { BrandMark } from '@/components/brand-mark'
import { MagicSignIn } from './magic-signin'

export const metadata = { title: 'Signing you in' }

export default async function MagicLinkPage({ searchParams }: PageProps<'/login/magic'>) {
  // Already signed in? The link did its job — land on the role home.
  const user = await getSessionUser()
  if (user) redirect(homeFor(user))

  const params = await searchParams
  const token = typeof params.token === 'string' ? params.token : ''

  return (
    <main className="relative grid min-h-dvh place-items-center px-6 py-12">
      <div
        aria-hidden
        className="bg-brand-soft/60 pointer-events-none absolute -top-32 -left-32 size-96 rounded-full blur-3xl"
      />

      <div className="relative w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <BrandMark className="h-8" />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Magic sign-in</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One click from your email, no password needed.
        </p>

        {token ? (
          <MagicSignIn token={token} />
        ) : (
          <div className="border-warning/40 bg-warning/10 mt-8 rounded-md border p-4 text-sm">
            <p className="font-medium">This link is missing its token.</p>
            <p className="text-muted-foreground mt-1">
              Open the sign-in link from your email again, or request a fresh one below.
            </p>
          </div>
        )}

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
