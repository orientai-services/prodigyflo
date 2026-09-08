import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getSessionUser, requireUser } from '@/lib/rbac'
import { brandFor } from '@/components/brand/org-brand'
import { navigationFor, subroutesFor } from '@/lib/navigation'
import { ROLE_HOME } from '@/lib/permissions'
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

  // Clients never see the staff shell. The portal itself is deferred (P3), so
  // for now a portal account is told plainly that it has nowhere to go here.
  if (user.role === 'CLIENT') redirect(ROLE_HOME.CLIENT)

  // A pinned user (landingPath set — e.g. a Lead Recovery Flow demo account)
  // is confined to their own app: reaching any ProdigyFlo staff route bounces
  // them back, so they never see the full app behind the branded shell.
  if (user.landingPath && !user.landingPath.startsWith('/dashboard')) redirect(user.landingPath)

  const unreadCount = await db.notification.count({
    where: { userId: user.id, readAt: null },
  })

  // Agency users may switch between their home account and its direct,
  // non-deleted children — computed server-side so the shell only ever sees
  // a serializable list. Everyone else gets an empty list and the static
  // org name in the sidebar footer, exactly as before.
  let switchableOrgs: { id: string; name: string; kind: string; slug: string }[] = []
  if (user.organizationKind === 'AGENCY') {
    const homeOrganizationId = user.homeOrganizationId ?? user.organizationId
    const rows = await db.organization.findMany({
      where: {
        deletedAt: null,
        OR: [{ id: homeOrganizationId }, { parentOrganizationId: homeOrganizationId }],
      },
      orderBy: { name: 'asc' },
      // `slug` is the branding key the switcher renders an account's own mark from.
      select: { id: true, name: true, kind: true, slug: true },
    })
    // Home first, children A→Z after it.
    switchableOrgs = [
      ...rows.filter((o) => o.id === homeOrganizationId),
      ...rows.filter((o) => o.id !== homeOrganizationId),
    ]
  }

  return (
    <AppShell
      sections={navigationFor(user)}
      subroutes={subroutesFor(user)}
      unreadCount={unreadCount}
      switchableOrgs={switchableOrgs}
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
