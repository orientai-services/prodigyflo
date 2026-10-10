import type { RoleKey } from '@prisma/client'

/** Additional surface restriction; every data query still enforces assignment scope. */
export function staffRouteAllowed(role: RoleKey, path: string): boolean {
  if (process.env.PRODIGYFLO_FINAL_DESK === 'true' && !path.startsWith('/api/')) {
    if (!['SUPER_ADMIN', 'CLOSER'].includes(role)) return false
    // `/dashboard` is the installed app's start page and only redirects staff
    // to /board; gating it here sent a Super Admin to /forbidden on launch.
    if (['/', '/dashboard', '/board', '/call-center', '/clients', '/queue', '/documents', '/submissions', '/forbidden'].includes(path)) return true
    if (/^\/clients\/[^/]+(?:\/questionnaire)?$/.test(path)) return true
    if (role === 'SUPER_ADMIN' && /^\/marketing\/meta(\/|$)/.test(path)) return true
    return role === 'SUPER_ADMIN' && ['/engine', '/settings/users'].includes(path)
  }
  if (role === 'SUPER_ADMIN') return !/^\/agency(\/|$)/.test(path) && (process.env.PRODIGYFLO_FINAL_DESK === 'true' || !/^\/engine(\/|$)/.test(path))
  if (role !== 'CLOSER') return false
  if (path === '/api/desk' && process.env.PRODIGYFLO_FINAL_DESK === 'true') return true
  return /^\/(board|call-center|clients|queue|documents|submissions|profile|notifications|forbidden)(\/|$)/.test(path)
    || /^\/api\/(documents|cys|submissions|notifications|search|profile|signout|messages|templates|voice)(\/|$)/.test(path)
    || path === '/settings/profile' || path === '/'
}

/**
 * Where to land after sign-in. A `?next=` that this role may not open (an old
 * bookmark, a page hidden by the final desk, an installed app's stale start
 * page) would bounce straight to /forbidden, so it falls back to `home`.
 */
export function landingAfterLogin(role: RoleKey, next: unknown, home: string): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return home
  const path = next.split(/[?#]/, 1)[0]
  if (path === '/login' || path === '/forbidden' || !staffRouteAllowed(role, path)) return home
  return next
}
