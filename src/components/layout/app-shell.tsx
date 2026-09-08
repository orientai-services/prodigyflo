'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as Icons from 'lucide-react'
import { Building2, Menu, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AppBrand } from '@/components/brand/org-brand'
import type { NavItem, NavSection } from '@/lib/navigation'
import { CommandPalette } from '@/components/layout/command-palette'
import { OrgSwitcher, type SwitchableOrg } from '@/components/layout/org-switcher'
import { UserMenu } from '@/components/layout/user-menu'
import { NotificationBell } from '@/components/layout/notification-bell'
import { persistSidebarExpanded, readSidebarExpanded } from '@/components/layout/sidebar-state'

type ShellUser = {
  name: string
  email: string
  roleName: string
  organizationName: string
  avatarUrl: string | null
}

/**
 * Desktop-rail expansion lives OUTSIDE React: the `pf-nav-open` class on
 * <html> (stamped pre-paint from localStorage) plus localStorage itself.
 * Exposing it as an external store lets the shell render from it directly —
 * the server snapshot is the collapsed default, so hydration matches the SSR
 * HTML, and React re-renders from the real class right after (same idiom as
 * the theme store in user-menu.tsx). Width/labels never depend on this value;
 * they are pure CSS off the html class. This only gates ARIA + tooltips.
 */
const navListeners = new Set<() => void>()
const navStore = {
  subscribe(listener: () => void) {
    navListeners.add(listener)
    return () => {
      navListeners.delete(listener)
    }
  },
  get: () => readSidebarExpanded(),
  set(expanded: boolean) {
    persistSidebarExpanded(expanded)
    navListeners.forEach((l) => l())
  },
}

function NavIcon({ name, className }: { name: string; className?: string }) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
  return Icon ? <Icon className={className} /> : <Icons.Circle className={className} />
}

/**
 * The nav list, rendered twice: `rail` for the desktop sidebar and plain for
 * the mobile drawer.
 *
 * The rail variant keeps ONE DOM shape for both the collapsed and expanded
 * states — labels and section titles are hidden/revealed purely by CSS keyed
 * off the `pf-nav-open` class the pre-paint script stamps on <html>. That is
 * what lets the server (which cannot read localStorage) render HTML that is
 * correct for either state, with zero width flash and zero hydration
 * mismatch. Only tooltip gating uses React state (`expanded`), which syncs
 * from the class after hydration.
 */
function NavSections({
  sections,
  pathname,
  rail = false,
  expanded = true,
}: {
  sections: NavSection[]
  pathname: string
  rail?: boolean
  expanded?: boolean
}) {
  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <nav
      className={cn('space-y-6 px-3 py-4', rail && 'space-y-4 [.pf-nav-open_&]:space-y-6')}
      aria-label="Main"
    >
      {sections.map((section, index) => (
        <div key={section.title}>
          {/* Collapsed rail: subtle separators stand in for section titles. */}
          {rail && index > 0 && (
            <div aria-hidden="true" className="border-sidebar-border mx-2 mb-3 border-t [.pf-nav-open_&]:hidden" />
          )}
          <p
            className={cn(
              'text-muted-foreground px-2 pb-1.5 text-[0.7rem] font-medium tracking-wide uppercase',
              rail && 'hidden [.pf-nav-open_&]:block',
            )}
          >
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(item.href, item.exact)
              const linkClass = cn(
                'focus-visible:ring-ring flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                rail && 'justify-center gap-0 [.pf-nav-open_&]:justify-start [.pf-nav-open_&]:gap-2.5',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )
              const inner = (
                <>
                  <NavIcon name={item.icon} className="size-4 shrink-0" />
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      rail &&
                        'w-0 opacity-0 motion-safe:transition-opacity motion-safe:duration-200 [.pf-nav-open_&]:w-auto [.pf-nav-open_&]:flex-1 [.pf-nav-open_&]:opacity-100',
                    )}
                  >
                    {item.label}
                  </span>
                </>
              )
              return (
                <li key={item.href}>
                  {rail ? (
                    <Tooltip disabled={expanded}>
                      <TooltipTrigger
                        render={
                          <Link
                            href={item.href}
                            aria-current={active ? 'page' : undefined}
                            className={linkClass}
                          />
                        }
                      >
                        {inner}
                      </TooltipTrigger>
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Link href={item.href} aria-current={active ? 'page' : undefined} className={linkClass}>
                      {inner}
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function AppShell({
  sections,
  subroutes = [],
  user,
  unreadCount,
  switchableOrgs = [],
  activeOrgId,
  activeOrgSlug,
  children,
}: {
  sections: NavSection[]
  subroutes?: NavItem[]
  user: ShellUser
  unreadCount: number
  /** Agency users only: the accounts they may switch between (home first). */
  switchableOrgs?: SwitchableOrg[]
  activeOrgId?: string
  /**
   * Slug of the ACTIVE account. The masthead follows it, so a user who has
   * switched into a client account sees that client's mark rather than the
   * agency's — see components/brand/org-brand.tsx.
   */
  activeOrgSlug?: string
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [drawerRoute, setDrawerRoute] = useState(pathname)

  // Desktop rail expansion, read from the external store above.
  const navExpanded = useSyncExternalStore(navStore.subscribe, navStore.get, () => false)
  const toggleNav = () => navStore.set(!navExpanded)

  // Navigating closes the drawer. Adjusting state during render is React's
  // documented alternative to doing this in an effect, and avoids the extra pass.
  if (drawerRoute !== pathname) {
    setDrawerRoute(pathname)
    setMobileOpen(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Agency users get the account switcher where the static org name lives;
  // everyone else keeps the plain label — the list is computed server-side
  // and arrives empty for non-agency users. The rail variant collapses to an
  // icon button (CSS-driven, same DOM) that still opens the full dropdown.
  const orgFooter = (rail: boolean) =>
    switchableOrgs.length > 0 && activeOrgId ? (
      <div className={cn('shrink-0 border-t px-2 py-2')}>
        <OrgSwitcher
          orgs={switchableOrgs}
          activeOrgId={activeOrgId}
          variant={rail ? 'rail' : 'default'}
          tooltipDisabled={!rail || navExpanded}
        />
      </div>
    ) : rail ? (
      <div className="shrink-0 border-t px-2 py-3 [.pf-nav-open_&]:px-4">
        <Tooltip disabled={navExpanded}>
          <TooltipTrigger
            render={<div className="flex justify-center [.pf-nav-open_&]:hidden" />}
          >
            <Building2 className="text-muted-foreground size-4" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="right">{user.organizationName}</TooltipContent>
        </Tooltip>
        <p className="text-muted-foreground hidden truncate text-xs [.pf-nav-open_&]:block">
          {user.organizationName}
        </p>
      </div>
    ) : (
      <div className="shrink-0 border-t px-4 py-3">
        <p className="text-muted-foreground truncate text-xs">{user.organizationName}</p>
      </div>
    )

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar — a collapsed icon rail by default, expanded to the
          full 240px layout when <html> carries `pf-nav-open` (stamped before
          first paint from localStorage). The flex row means the main column
          reflows off this width automatically. */}
      <aside
        id="pf-desktop-nav"
        className="bg-sidebar hidden w-16 shrink-0 flex-col border-r motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out lg:flex [.pf-nav-open_&]:w-60"
      >
        <TooltipProvider delay={300}>
          <div className="flex h-14 shrink-0 items-center justify-center [.pf-nav-open_&]:justify-start [.pf-nav-open_&]:px-4">
            <Link
              href="/"
              className="focus-visible:ring-ring flex items-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
            >
              {/* Two marks, CSS-toggled, so the wordmark appears without a remount. */}
              <AppBrand slug={activeOrgSlug} className="hidden h-7 [.pf-nav-open_&]:inline-flex" />
              <AppBrand slug={activeOrgSlug} showWordmark={false} className="h-7 [.pf-nav-open_&]:hidden" />
            </Link>
          </div>
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <NavSections sections={sections} pathname={pathname} rail expanded={navExpanded} />
            </ScrollArea>
          </div>
          {/* Expand/collapse seam at the sidebar foot. */}
          <div className="shrink-0 border-t p-2">
            <Tooltip disabled={navExpanded}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleNav}
                    aria-expanded={navExpanded}
                    aria-controls="pf-desktop-nav"
                    aria-label={navExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
                    className="text-muted-foreground hover:text-foreground w-full [.pf-nav-open_&]:justify-start [.pf-nav-open_&]:px-2"
                  />
                }
              >
                {/* Both icons live in the DOM; CSS picks the one matching the
                    stamped class so the first paint is always right. */}
                <PanelLeftOpen className="size-4 [.pf-nav-open_&]:hidden" aria-hidden="true" />
                <PanelLeftClose className="hidden size-4 [.pf-nav-open_&]:block" aria-hidden="true" />
                <span className="hidden text-xs [.pf-nav-open_&]:inline">Collapse</span>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          </div>
          {orgFooter(true)}
        </TooltipProvider>
      </aside>

      {/* Mobile drawer — animated Sheet: overlay fades, panel slides in from
          the left. Close-on-navigate is handled by the render-phase state
          adjustment above, exactly as before. Always full labels — the rail
          is desktop-only. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="bg-sidebar gap-0 p-0 data-[side=left]:w-72 data-[side=left]:max-w-[85vw] lg:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
            <Link href="/" className="flex items-center">
              <AppBrand slug={activeOrgSlug} className="h-7" />
            </Link>
            <SheetClose
              render={<Button variant="ghost" size="icon-sm" aria-label="Close menu" />}
            >
              <X className="size-4" />
            </SheetClose>
          </div>
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <NavSections sections={sections} pathname={pathname} />
            </ScrollArea>
          </div>
          {orgFooter(false)}
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 supports-backdrop-filter:bg-background/65 sticky top-0 z-40 flex h-14 items-center gap-2 border-b px-3 backdrop-blur-md sm:px-5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-4" />
          </Button>

          {/* The sidebar carries the mark on desktop; on smaller screens the
              header does, so the brand never disappears. */}
          <Link href="/" className="flex items-center lg:hidden">
            <AppBrand slug={activeOrgSlug} className="h-6" />
          </Link>

          {/* Full search field from sm up; a plain icon below that. */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="text-muted-foreground hover:bg-muted hidden h-8 min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors sm:flex sm:max-w-sm"
          >
            <Search className="size-3.5 shrink-0" />
            <span className="truncate">Search clients, people, actions…</span>
            <kbd className="bg-muted text-muted-foreground ml-auto hidden shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.65rem] sm:inline">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="sm:hidden"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
            >
              <Search className="size-4" />
            </Button>
            <NotificationBell unreadCount={unreadCount} />
            <UserMenu user={user} />
          </div>
        </header>

        <main className="min-w-0 flex-1">
          {/* Page-body entrance, wired once for every page. Keyed by pathname
              so client-side navigations replay it; search-param changes do
              not. Inert under prefers-reduced-motion. */}
          <div
            key={pathname}
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300"
          >
            {children}
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} sections={sections} subroutes={subroutes} />
    </div>
  )
}
