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
    await db.team.create({ data: { organizationId: orgId, name: 'Team Prodigy' } })
    // audit needs a real actor row for admin actions? recordAudit only stores actorId string — fine.
  })

  afterAll(async () => {
    await db.organization.delete({ where: { id: orgId } })
  })

  it('only Super Admin can grant either active role, regardless of owner flag', () => {
    expect(assignableRoles(admin)).toEqual([])
    expect(assignableRoles(superAdmin)).toEqual(['SUPER_ADMIN', 'CLOSER'])
    expect(assignableRoles({ ...superAdmin, isOwner: true })).toEqual(assignableRoles(superAdmin))
    expect(canManageUser(admin, { id: 'other', roleKey: 'CLOSER' })).toBe(false)
    expect(canManageUser(superAdmin, { id: superAdmin.id, roleKey: 'SUPER_ADMIN', isOwner: true })).toBe(true)
  })

  it('allows more than two Super Admin seats', async () => {
    const saRole = await db.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'SUPER_ADMIN' } })
    await db.user.create({ data: { organizationId: orgId, roleId: saRole.id, isOwner: true, email: `own-${run}@t.test`, name: 'O', passwordHash: 'x' } })
    for (let n = 0; n < 3; n++) await createInvite(superAdmin, { email: `seat${n}-${run}@t.test`, roleKey: 'SUPER_ADMIN' })
  })

  it('creates, finds, and accepts an invite exactly once', async () => {
    const { token } = await createInvite(superAdmin, { email: `NEW-${run}@T.Test`, roleKey: 'CLOSER' })

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
      createInvite(superAdmin, { email: `sa-${run}@t.test`, roleKey: 'CLOSER' }),
    ).rejects.toThrow(/already exists/)

    await createInvite(superAdmin, { email: `pend-${run}@t.test`, roleKey: 'CLOSER' })
    await expect(
      createInvite(superAdmin, { email: `pend-${run}@t.test`, roleKey: 'CLOSER' }),
    ).rejects.toThrow(/pending/)
  })

  it('admin cannot grant admin; reset rotates the token; revoke kills it', async () => {
    await expect(createInvite(admin, { email: `x-${run}@t.test`, roleKey: 'CLOSER' })).rejects.toThrow(/cannot grant/)

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
