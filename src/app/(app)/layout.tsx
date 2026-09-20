import { finalDeskEnabled } from '@/lib/final-desk/data'
import { notificationScope } from '@/lib/notification-scope'
import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { getSessionUser, requireUser } from '@/lib/rbac'
import { brandFor } from '@/components/brand/org-brand'
import { navigationFor, subroutesFor } from '@/lib/navigation'
import { AppShell } from '@/components/layout/app-shell'

/**
 * Installed-app identity follows the ACTIVE account.
 *
 * Two mechanisms, because the platforms disagree and each ignores the other:
 * Android reads the MANIFEST's name/icons, while iOS ignores manifest icons for
 * Add to Home Screen entirely and uses `apple-touch-icon`. Setting only one
 * leaves half the users with a ProdigyFlo tile on their home screen while they
 * are working inside a client account.
 *
 * The manifest URL carries the slug rather than being resolved from the cookie:
 * browsers fetch manifests without credentials, so a cookie-aware manifest
 * would always answer as the agency. See src/app/manifest/[slug]/route.ts.
 *
 * `getSessionUser` is React-`cache`d, so this shares its query with the layout
 * body below rather than adding one.
 */
export async function generateMetadata(): Promise<Metadata> {
  const user = await getSessionUser()
  const brand = brandFor(user?.organizationSlug)
  return {
    title: { default: brand.name, template: `%s · ${brand.shortName}` },
    applicationName: brand.name,
    manifest: `/manifest/${brand.iconDir}`,
    appleWebApp: { capable: true, title: brand.shortName, statusBarStyle: 'default' },
    icons: {
      apple: [{ url: `/brand/${brand.iconDir}/apple-touch-icon.png`, sizes: '180x180' }],
      icon: [{ url: `/brand/${brand.iconDir}/icon-192.png`, sizes: '192x192', type: 'image/png' }],
    },
  }
}

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const user = await requireUser()
  if (finalDeskEnabled()) return <>{children}</>

  const unreadCount = await db.notification.count({
    where: { ...await notificationScope(user), readAt: null },
  })

  return (
    <AppShell
      sections={navigationFor(user)}
      subroutes={subroutesFor(user)}
      unreadCount={unreadCount}
      switchableOrgs={[]}
      activeOrgId={user.organizationId}
      activeOrgSlug={user.organizationSlug}
      user={{
        name: user.name,
        email: user.email,
        roleName: user.roleName,
        organizationName: user.organizationName,
        avatarUrl: user.avatarUrl,
      }}
    >
      {children}
    </AppShell>
  )
}
