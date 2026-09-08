import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCsv, rowToRecord, suggestMapping, validateRecord } from '@/lib/csv'
import { clientScope, type SessionUser } from '@/lib/rbac'
import type { PermissionKey } from '@/lib/permissions'
import { db } from '@/lib/db'

// ── CSV parsing ──────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses headers and rows', () => {
    const { headers, rows } = parseCsv('first,last\nMaria,Lopez\nJoe,Smith\n')
    expect(headers).toEqual(['first', 'last'])
    expect(rows).toEqual([
      ['Maria', 'Lopez'],
      ['Joe', 'Smith'],
    ])
  })

  it('handles quoted cells with commas, quotes and newlines', () => {
    const text = 'name,note\r\n"Lopez, Maria","She said ""hi""\nsecond line"\r\n'
    const { rows } = parseCsv(text)
    expect(rows).toEqual([['Lopez, Maria', 'She said "hi"\nsecond line']])
  })

  it('drops fully empty lines and strips a BOM', () => {
    const { headers, rows } = parseCsv('\uFEFFa,b\n\n1,2\n,,\n')
    expect(headers).toEqual(['a', 'b'])
    expect(rows).toEqual([['1', '2']])
  })
})

// ── Mapping ──────────────────────────────────────────────────────────────────

describe('suggestMapping', () => {
  it('recognises common header names case-insensitively', () => {
    const mapping = suggestMapping(['First Name', 'LAST_NAME', 'E-mail', 'Cell', 'Zip Code'])
    expect(mapping.firstName).toBe(0)
    expect(mapping.lastName).toBe(1)
    expect(mapping.email).toBe(2)
    expect(mapping.phone).toBe(3)
    expect(mapping.postalCode).toBe(4)
  })

  it('leaves unknown fields unmapped', () => {
    const mapping = suggestMapping(['favourite colour'])
    expect(mapping.firstName).toBe(-1)
    expect(mapping.email).toBe(-1)
  })
})

describe('rowToRecord + validateRecord', () => {
  const mapping = { ...suggestMapping(['firstname', 'lastname', 'email', 'phone']) }

  it('builds a record from mapped columns and skips blanks', () => {
    const record = rowToRecord(['Maria', 'Lopez', '', ' 7025550134 '], mapping)
    expect(record).toEqual({ firstName: 'Maria', lastName: 'Lopez', phone: '7025550134' })
  })

  it('requires a name and at least one contact channel', () => {
    expect(validateRecord({ firstName: 'Maria' })).toContain('Missing last name')
    expect(validateRecord({ firstName: 'Maria', lastName: 'Lopez' })).toContain('Needs an email or a phone')
    expect(validateRecord({ firstName: 'M', lastName: 'L', email: 'not-an-email' })).toContain('Invalid email')
    expect(validateRecord({ firstName: 'M', lastName: 'L', phone: '7025550134' })).toEqual([])
  })
})

// ── DB-backed scoping ────────────────────────────────────────────────────────

function sessionUser(overrides: Partial<SessionUser> & { organizationId: string }): SessionUser {
  return {
    id: 'test-user',
    name: 'Test User',
    email: 'test@example.com',
    organizationName: 'Test Org',
    roleId: 'role',
    isOwner: false,
    role: 'CLOSER',
    roleName: 'Closer',
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set<PermissionKey>(['clients:read_assigned']),
    portalClientId: null,
    ...overrides,
  }
}

describe('client scoping (DB)', () => {
  const stamp = `crmtest-${Date.now()}`
  let orgA: string
  let orgB: string
  let clientInB: string

  beforeAll(async () => {
    const mkOrg = async (suffix: string) => {
      const org = await db.organization.create({
        data: { name: `CRM Test ${suffix}`, slug: `${stamp}-${suffix}` },
      })
      const pipeline = await db.pipeline.create({
        data: { organizationId: org.id, name: 'Test pipeline', isDefault: true },
      })
      const stage = await db.pipelineStage.create({
        data: {
          pipelineId: pipeline.id,
          key: 'NEW_LEAD',
          name: 'New lead',
          category: 'INTAKE',
          position: 0,
        },
      })
      return { org, pipeline, stage }
    }

    const a = await mkOrg('a')
    const b = await mkOrg('b')
    orgA = a.org.id
    orgB = b.org.id

    const client = await db.client.create({
      data: {
        organizationId: orgB,
        pipelineId: b.pipeline.id,
        currentStageId: b.stage.id,
        firstName: 'Cross',
        lastName: 'Tenant',
        email: `${stamp}@example.com`,
        phone: '7025550199',
      },
    })
    clientInB = client.id
  })

  afterAll(async () => {
    // Cascades take the pipeline, stages, and client with each organization.
    await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
  })

  it('a client in another organization is not reachable through clientScope', async () => {
    const userInA = sessionUser({
      organizationId: orgA,
      permissions: new Set<PermissionKey>(['clients:read_all']),
    })
    const found = await db.client.findFirst({
      where: { AND: [clientScope(userInA), { id: clientInB }] },
    })
    expect(found).toBeNull()
  })

  it('an assigned-only user cannot reach an unassigned client even in their own org', async () => {
    const userInB = sessionUser({ organizationId: orgB })
    const found = await db.client.findFirst({
      where: { AND: [clientScope(userInB), { id: clientInB }] },
    })
    expect(found).toBeNull()
  })

  it('the same client is reachable once the user owns it', async () => {
    const owner = await db.role
      .findFirst({ where: { organizationId: orgB } })
      .then(async (existing) => {
        const role =
          existing ??
          (await db.role.create({
            data: { organizationId: orgB, key: 'CLOSER', name: 'Closer' },
          }))
        return db.user.create({
          data: {
            organizationId: orgB,
            roleId: role.id,
            email: `${stamp}-owner@example.com`,
            passwordHash: 'x',
            name: 'Owner InB',
          },
        })
      })

    await db.client.update({ where: { id: clientInB }, data: { ownerId: owner.id } })

    const userInB = sessionUser({ organizationId: orgB, id: owner.id })
    const found = await db.client.findFirst({
      where: { AND: [clientScope(userInB), { id: clientInB }] },
    })
    expect(found?.id).toBe(clientInB)
  })
})
