import { redirect } from 'next/navigation'
import { BrandMark } from '@/components/brand-mark'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'
import { SignupForm } from './signup-form'

export const metadata = { title: 'Create admin account' }

export default async function SignupPage() {
  if (process.env.ALLOW_SELF_SIGNUP !== 'true') redirect('/login')

  const user = await getSessionUser()
  if (user) redirect(homeFor(user))

  return (
    <main className="relative grid min-h-dvh lg:grid-cols-2">
      <div aria-hidden className="bg-brand-soft/60 pointer-events-none absolute -top-32 -left-32 size-96 rounded-full blur-3xl" />
      <div className="relative flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <BrandMark className="h-8" />
          <h1 className="mt-8 text-2xl font-semibold tracking-tight">Create your admin account</h1>
          <p className="text-muted-foreground mt-1 text-sm">Set up a new ProdigyFlo workspace. You will be its owner and Super Admin.</p>
          <SignupForm />
        </div>
      </div>
      <aside className="bg-sidebar hidden border-l lg:flex lg:flex-col lg:justify-center lg:px-16">
        <BrandMark tagline className="w-full max-w-sm" />
      </aside>
    </main>
  )
}
