import { LogOut } from 'lucide-react'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { PORTAL_COPY, requirePortalClient } from '@/lib/portal'

export const metadata = { title: 'Your portal' }

/**
 * The portal's own minimal shell — deliberately NOT the staff AppShell.
 * No navigation, no staff chrome: a slim branded header with the signed-in
 * client's name and a sign-out control, mobile-first underneath.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { client } = await requirePortalClient()

  return (
    <div className="bg-surface-sunk flex min-h-dvh flex-col">
      <header className="bg-background/95 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-6" />
            <span className="text-muted-foreground hidden text-xs sm:inline">{PORTAL_COPY.brandTagline}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground max-w-40 truncate text-sm sm:max-w-none">
              {client.firstName} {client.lastName}
            </span>
            <form action="/api/signout" method="post">
              <Button type="submit" variant="ghost" size="sm">
                <LogOut data-icon="inline-start" />
                <span className="hidden sm:inline">{PORTAL_COPY.signOut}</span>
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>

      <footer className="text-muted-foreground border-t px-4 py-6 text-center text-xs">
        <p>{PORTAL_COPY.needHelp}</p>
        <p className="mt-1">{client.organization.name}</p>
      </footer>
    </div>
  )
}
