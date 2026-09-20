import type { RoleKey } from '@prisma/client'

/** Additional surface restriction; every data query still enforces assignment scope. */
export function staffRouteAllowed(role: RoleKey, path: string): boolean {
  if (process.env.PRODIGYFLO_FINAL_DESK === 'true' && !path.startsWith('/api/')) {
    if (!['SUPER_ADMIN', 'CLOSER'].includes(role)) return false
    if (['/', '/board', '/clients', '/queue', '/documents', '/submissions', '/forbidden'].includes(path)) return true
    if (/^\/clients\/[^/]+(?:\/questionnaire)?$/.test(path)) return true
    return role === 'SUPER_ADMIN' && ['/engine', '/settings/users'].includes(path)
  }
  if (role === 'SUPER_ADMIN') return !/^\/agency(\/|$)/.test(path) && (process.env.PRODIGYFLO_FINAL_DESK === 'true' || !/^\/engine(\/|$)/.test(path))
  if (role !== 'CLOSER') return false
  if (path === '/api/desk' && process.env.PRODIGYFLO_FINAL_DESK === 'true') return true
  return /^\/(board|clients|queue|documents|submissions|profile|notifications|forbidden)(\/|$)/.test(path)
    || /^\/api\/(documents|cys|submissions|notifications|search|profile|signout|messages|templates)(\/|$)/.test(path)
    || path === '/settings/profile' || path === '/'
}
