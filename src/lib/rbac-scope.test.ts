import { describe, expect, it } from 'vitest'
import { clientScope, can, type SessionUser } from '@/lib/rbac'
import { staffRouteAllowed } from '@/lib/staff-routes'
const user = { id: 'closer', organizationId: 'team', permissions: new Set(['clients:read_all', 'submissions:approve']), isOwner: true } as SessionUser

describe('staff authorization', () => {
  it('gives Super Admin all authority, independent of the retired owner flag', () => {
    const admin = { ...user, role: 'SUPER_ADMIN', isOwner: false } as SessionUser
    expect(clientScope(admin)).toEqual({ organizationId: 'team', deletedAt: null })
    expect(can(admin, 'users:manage')).toBe(true)
  })
  it('never widens Closer assignment scope with legacy grants or owner flags', () => {
    const closer = { ...user, role: 'CLOSER' } as SessionUser
    expect(clientScope(closer)).toEqual({ organizationId: 'team', deletedAt: null, ownerId: 'closer' })
    expect(can(closer, 'clients:read_all')).toBe(false)
    expect(can(closer, 'submissions:approve')).toBe(true)
    expect(can({ ...closer, permissions: new Set() }, 'submissions:approve')).toBe(false)
  })
  it.each(['ADMIN', 'REGIONAL_MANAGER', 'SALES_MANAGER', 'DOCUMENT_COLLECTOR', 'MARKETING', 'CLIENT'] as const)('denies retired %s roles', (role) => {
    expect(clientScope({ ...user, role })).toHaveProperty('id', '__none__')
    expect(can({ ...user, role }, 'users:manage')).toBe(false)
  })
  it('denies direct legacy URLs and Pipeline to Closers, and Engine to everyone', () => {
    for (const route of ['/pipeline', '/engine', '/marketing', '/sales/qualifier', '/settings/users', '/api/reports/revenue']) expect(staffRouteAllowed('CLOSER', route)).toBe(false)
    for (const route of ['/board', '/clients/a', '/documents', '/submissions', '/api/documents/a/file']) expect(staffRouteAllowed('CLOSER', route)).toBe(true)
    expect(staffRouteAllowed('SUPER_ADMIN', '/pipeline')).toBe(true)
    expect(staffRouteAllowed('SUPER_ADMIN', '/engine')).toBe(false)
  })
})
