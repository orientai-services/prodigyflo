import type { RoleKey } from '@prisma/client'

/** Additional surface restriction; every data query still enforces assignment scope. */
export function staffRouteAllowed(role: RoleKey, path: string): boolean {
  if (role === 'SUPER_ADMIN') return !/^\/(engine|agency)(\/|$)/.test(path)
  if (role !== 'CLOSER') return false
  return /^\/(board|clients|queue|documents|submissions|profile|notifications|forbidden)(\/|$)/.test(path)
    || /^\/api\/(documents|cys|submissions|notifications|search|profile|signout|messages|templates)(\/|$)/.test(path)
    || path === '/settings/profile' || path === '/'
}
