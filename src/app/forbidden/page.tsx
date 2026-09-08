import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'

export const metadata = { title: 'Not permitted' }

export default async function ForbiddenPage() {
  const user = await getSessionUser()
  const home = user ? homeFor(user) : '/login'
  // CLIENT accounts live in the client portal, not the staff app — point them
  // back there instead of at a staff page they can never open.
  const isPortalUser = user?.role === 'CLIENT'

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
          <ShieldAlert className="text-muted-foreground size-6" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">You don&apos;t have access to this</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {!user
            ? 'Sign in to continue.'
            : isPortalUser
              ? 'This page is part of the staff workspace. Your account uses the client portal instead.'
              : `Your role (${user.roleName}) doesn't include permission for this page. If you need it, ask an administrator.`}
        </p>
        {isPortalUser ? (
          <Button className="mt-6" render={<Link href={home} />}>
            Go to your portal
          </Button>
        ) : (
          <Button className="mt-6" render={<Link href={home} />}>
            Back to your dashboard
          </Button>
        )}
      </div>
    </main>
  )
}
