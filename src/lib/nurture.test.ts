import { describe, expect, it } from 'vitest'
import type { RoleKey } from '@prisma/client'
import type { PermissionKey } from '@/lib/permissions'
import { ForbiddenError, type SessionUser } from '@/lib/rbac'
import {
  confirmNurtureTouch,
  isValidNurtureUrl,
  nurtureStatus,
  portalCanConfirmTouch,
  recordNurtureTouch,
  senderFirstName,
} from '@/lib/nurture'

function session(role: RoleKey, permissions: PermissionKey[]): SessionUser {
  return {
    id: 'u1',
    name: 'Test User',
    email: 'user@example.com',
    organizationId: 'org1',
    organizationName: 'Org',
    roleId: 'role1',
    role,
    roleName: role,
    isOwner: false,
    regionId: null,
    teamId: null,
    managerId: null,
    avatarUrl: null,
    title: null,
    permissions: new Set(permissions),
    portalClientId: role === 'CLIENT' ? 'client_1' : null,
  }
}

describe('nurtureStatus', () => {
  it('is none with no touches', () => {
    expect(nurtureStatus([])).toBe('none')
  })

  it('is sent when touches exist but none are confirmed', () => {
    expect(nurtureStatus([{ confirmedAt: null }])).toBe('sent')
    expect(nurtureStatus([{ confirmedAt: null }, { confirmedAt: null }])).toBe('sent')
  })

  it('is confirmed as soon as any touch is confirmed', () => {
    expect(nurtureStatus([{ confirmedAt: new Date() }])).toBe('confirmed')
    expect(
      nurtureStatus([{ confirmedAt: null }, { confirmedAt: new Date('2026-08-01') }]),
    ).toBe('confirmed')
  })

  it('confirmed wins regardless of touch order', () => {
    expect(
      nurtureStatus([{ confirmedAt: new Date() }, { confirmedAt: null }]),
    ).toBe('confirmed')
  })
})

describe('isValidNurtureUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidNurtureUrl('https://loom.com/share/abc123')).toBe(true)
    expect(isValidNurtureUrl('https://www.youtube.com/watch?v=x')).toBe(true)
  })

  it('rejects http and every other scheme', () => {
    expect(isValidNurtureUrl('http://loom.com/share/abc123')).toBe(false)
    expect(isValidNurtureUrl('ftp://example.com/file')).toBe(false)
    expect(isValidNurtureUrl('javascript:alert(1)')).toBe(false)
    expect(isValidNurtureUrl('data:text/html,<b>x</b>')).toBe(false)
  })

  it('rejects garbage and empty strings', () => {
    expect(isValidNurtureUrl('')).toBe(false)
    expect(isValidNurtureUrl('not a url')).toBe(false)
    expect(isValidNurtureUrl('loom.com/share/abc')).toBe(false)
    expect(isValidNurtureUrl('https://')).toBe(false)
  })
})

describe('portalCanConfirmTouch', () => {
  const touch = { clientId: 'client_1' }

  it('allows the CLIENT session linked to the touch client', () => {
    expect(portalCanConfirmTouch({ role: 'CLIENT', portalClientId: 'client_1' }, touch)).toBe(true)
  })

  it('rejects a CLIENT linked to a different client (someone else touch id)', () => {
    expect(portalCanConfirmTouch({ role: 'CLIENT', portalClientId: 'client_2' }, touch)).toBe(false)
  })

  it('rejects a CLIENT with no portal link', () => {
    expect(portalCanConfirmTouch({ role: 'CLIENT', portalClientId: null }, touch)).toBe(false)
  })

  it('rejects every staff role, even one whose id happens to match', () => {
    expect(portalCanConfirmTouch({ role: 'ADMIN', portalClientId: 'client_1' }, touch)).toBe(false)
    expect(portalCanConfirmTouch({ role: 'CLOSER', portalClientId: null }, touch)).toBe(false)
    expect(portalCanConfirmTouch({ role: 'SUPER_ADMIN', portalClientId: 'client_1' }, touch)).toBe(false)
  })
})

describe('internal nurture mutations — staff gate', () => {
  // Every rejection below fires BEFORE any database access, so these run as
  // pure unit tests: an ungated caller never even reaches the touch queries.

  it('recordNurtureTouch rejects a portal CLIENT session', async () => {
    await expect(
      recordNurtureTouch(session('CLIENT', ['portal:self']), { clientId: 'client_1', kind: 'VIDEO' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('recordNurtureTouch rejects a CLIENT even for the internal CALL_PREP kind', async () => {
    await expect(
      recordNurtureTouch(session('CLIENT', ['portal:self']), { clientId: 'client_1', kind: 'CALL_PREP' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('recordNurtureTouch rejects staff without communications:send (e.g. MARKETING)', async () => {
    await expect(
      recordNurtureTouch(session('MARKETING', ['analytics:org', 'clients:read_all']), {
        clientId: 'client_1',
        kind: 'EMAIL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('confirmNurtureTouch rejects a portal CLIENT session — the portal path is the only client path', async () => {
    await expect(
      confirmNurtureTouch(session('CLIENT', ['portal:self']), 'touch_1'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('confirmNurtureTouch rejects a CLIENT even if a role misconfig granted communications:send', async () => {
    await expect(
      confirmNurtureTouch(session('CLIENT', ['portal:self', 'communications:send']), 'touch_1'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('confirmNurtureTouch rejects staff without communications:send', async () => {
    await expect(
      confirmNurtureTouch(session('MARKETING', ['analytics:org']), 'touch_1'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('senderFirstName', () => {
  it('takes the first name from a full name', () => {
    expect(senderFirstName('Jordan Reyes')).toBe('Jordan')
    expect(senderFirstName('  Ana  Maria Lopez ')).toBe('Ana')
  })

  it('falls back when the name is missing or blank', () => {
    expect(senderFirstName(null)).toBe('Your advisor')
    expect(senderFirstName(undefined)).toBe('Your advisor')
    expect(senderFirstName('   ')).toBe('Your advisor')
    expect(senderFirstName('', 'Your team')).toBe('Your team')
  })
})
