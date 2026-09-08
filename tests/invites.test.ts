import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import type { SessionUser } from '@/lib/rbac'
import {
  InviteError, acceptInvite, assertNotLastSuperAdmin, assignableRoles,
  canManageUser, createInvite, findLiveInvite, resetInviteLink, revokeInvite,
} from '@/lib/invites'

const run = `inv-${Date.now().toString(36)}`

const fakeUser = (organizationId: string, role: SessionUser['role'], id = `${run}-${role}`): SessionUser => ({
  id, name: 'T', email: `${id}@t.test`, organizationId, organizationName: 'T',
  roleId: 'r', isOwner: false, role, roleName: role, regionId: null, teamId: null, managerId: null,
  avatarUrl: null, title: null, permissions: new Set(), portalClientId: null,
})

describe('invites', () => {
  let orgId: string
  let superAdmin: SessionUser
  let admin: SessionUser

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Org ${run}`, slug: run } })
    orgId = org.id
    for (const key of ['SUPER_ADMIN', 'ADMIN', 'CLOSER'] as const) {
      await db.role.create({ data: { organizationId: orgId, key, name: key } })
    }
    const saRole = await db.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'SUPER_ADMIN' } })
    const sa = await db.user.create({
      data: { organizationId: orgId, roleId: saRole.id, email: `sa-${run}@t.test`, name: 'SA', passwordHash: 'x' },
    })
    superAdmin = { ...fakeUser(orgId, 'SUPER_ADMIN'), id: sa.id }
    admin = fakeUser(orgId, 'ADMIN')
    // audit needs a real actor row for admin actions? recordAudit only stores actorId string — fine.
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: orgId } })
  })

  it('rank rules: only the owner mints Super Admins', () => {
    const owner = { ...fakeUser(orgId, 'SUPER_ADMIN', `${run}-owner`), isOwner: true }
    expect(assignableRoles(admin)).not.toContain('SUPER_ADMIN')
    expect(assignableRoles(admin)).not.toContain('ADMIN')
    expect(assignableRoles(admin)).toContain('CLOSER')
    // a non-owner Super Admin can no longer mint peers
    expect(assignableRoles(superAdmin)).not.toContain('SUPER_ADMIN')
    expect(assignableRoles(superAdmin)).toContain('ADMIN')
    expect(assignableRoles(owner)).toContain('SUPER_ADMIN')
    expect(assignableRoles(owner)).not.toContain('CLIENT')
  })

  it('canManageUser: never self, never upward — and the owner is untouchable', () => {
    const owner = { ...fakeUser(orgId, 'SUPER_ADMIN', `${run}-owner`), isOwner: true }
    expect(canManageUser(admin, { id: admin.id, roleKey: 'ADMIN' })).toBe(false)
    expect(canManageUser(admin, { id: 'other', roleKey: 'SUPER_ADMIN' })).toBe(false)
    expect(canManageUser(admin, { id: 'other', roleKey: 'CLOSER' })).toBe(true)
    // even a Super Admin cannot manage the owner (who reads as a mere peer)
    expect(canManageUser(superAdmin, { id: 'o', roleKey: 'SUPER_ADMIN', isOwner: true })).toBe(false)
    // the owner can manage a Super Admin
    expect(canManageUser(owner, { id: 'sa', roleKey: 'SUPER_ADMIN' })).toBe(true)
  })

  it('Super Admin seats are capped for the owner (owner excluded from the count)', async () => {
    const saRole = await db.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'SUPER_ADMIN' } })
    const ownerRow = await db.user.create({
      data: { organizationId: orgId, roleId: saRole.id, isOwner: true, email: `own-${run}@t.test`, name: 'O', passwordHash: 'x' },
    })
    const owner = { ...fakeUser(orgId, 'SUPER_ADMIN', ownerRow.id), id: ownerRow.id, isOwner: true }
    // one non-owner Super Admin already exists (the fixture) → one seat left of 2
    await createInvite(owner, { email: `seat1-${run}@t.test`, roleKey: 'SUPER_ADMIN' })
    await expect(
      createInvite(owner, { email: `seat2-${run}@t.test`, roleKey: 'SUPER_ADMIN' }),
    ).rejects.toThrow(/seats are taken/)
  })

  it('creates, finds, and accepts an invite exactly once', async () => {
    const { token } = await createInvite(superAdmin, { email: `NEW-${run}@T.Test`, roleKey: 'ADMIN' })

    const live = await findLiveInvite(token)
    expect(live?.email).toBe(`new-${run}@t.test`) // normalized

    const user = await acceptInvite(token, { name: 'Nadia Invited', password: 'longenoughpw1' })
    expect(user.email).toBe(`new-${run}@t.test`)

    // consumed: the same link can never mint a second user
    expect(await findLiveInvite(token)).toBeNull()
    await expect(acceptInvite(token, { name: 'Again', password: 'longenoughpw1' })).rejects.toThrow(InviteError)
  })

  it('refuses invites for existing users and duplicate pending invites', async () => {
    await expect(
      createInvite(superAdmin, { email: `sa-${run}@t.test`, roleKey: 'ADMIN' }),
    ).rejects.toThrow(/already exists/)

    await createInvite(superAdmin, { email: `pend-${run}@t.test`, roleKey: 'CLOSER' })
    await expect(
      createInvite(superAdmin, { email: `pend-${run}@t.test`, roleKey: 'CLOSER' }),
    ).rejects.toThrow(/pending/)
  })

  it('admin cannot grant admin; reset rotates the token; revoke kills it', async () => {
    await expect(createInvite(admin, { email: `x-${run}@t.test`, roleKey: 'ADMIN' })).rejects.toThrow(/cannot grant/)

    const { invite, token } = await createInvite(superAdmin, { email: `rot-${run}@t.test`, roleKey: 'CLOSER' })
    const { token: token2 } = await resetInviteLink(superAdmin, invite.id)
    expect(await findLiveInvite(token)).toBeNull()      // old link dead
    expect(await findLiveInvite(token2)).not.toBeNull() // new link live

    await revokeInvite(superAdmin, invite.id)
    expect(await findLiveInvite(token2)).toBeNull()
  })

  it('expired invites are not live', async () => {
    const { invite, token } = await createInvite(superAdmin, { email: `exp-${run}@t.test`, roleKey: 'CLOSER' })
    await db.invite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await findLiveInvite(token)).toBeNull()
  })

  it('the last active super admin is protected — unless the owner remains', async () => {
    // an owner row exists (from the seat test), so the fixture SA is deactivatable
    await expect(assertNotLastSuperAdmin(orgId, superAdmin.id)).resolves.toBeUndefined()

    // with the owner out of the picture, the fixture SA becomes the last one
    await db.user.updateMany({ where: { organizationId: orgId, isOwner: true }, data: { isActive: false } })
    await expect(assertNotLastSuperAdmin(orgId, superAdmin.id)).rejects.toThrow(/last active Super Admin/)
    await db.user.updateMany({ where: { organizationId: orgId, isOwner: true }, data: { isActive: true } })

    // a CLOSER is never protected
    const closerRole = await db.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'CLOSER' } })
    const c = await db.user.create({
      data: { organizationId: orgId, roleId: closerRole.id, email: `c-${run}@t.test`, name: 'C', passwordHash: 'x' },
    })
    await expect(assertNotLastSuperAdmin(orgId, c.id)).resolves.toBeUndefined()
  })

  it('open link invites: no email upfront, bound at acceptance, single use', async () => {
    const { invite, token } = await createInvite(superAdmin, { email: null, roleKey: 'CLOSER' })
    expect(invite.email).toBeNull()

    // acceptance without an email is refused for open links
    await expect(acceptInvite(token, { name: 'No Mail', password: 'longenoughpw1' })).rejects.toThrow(/valid email/)

    const user = await acceptInvite(token, { name: 'Linked Joiner', password: 'longenoughpw1', email: `LINK-${run}@T.test` })
    expect(user.email).toBe(`link-${run}@t.test`)

    const stamped = await db.invite.findUniqueOrThrow({ where: { id: invite.id } })
    expect(stamped.email).toBe(`link-${run}@t.test`)   // claimed email recorded
    expect(await findLiveInvite(token)).toBeNull()      // single use

    // a second open link cannot mint a duplicate of an existing email
    const { token: token2 } = await createInvite(superAdmin, { email: null, roleKey: 'CLOSER' })
    await expect(
      acceptInvite(token2, { name: 'Dup', password: 'longenoughpw1', email: `link-${run}@t.test` }),
    ).rejects.toThrow(/already exists/)
  })
})
