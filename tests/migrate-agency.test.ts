import { describe, expect, it } from 'vitest'
import {
  AGENCY_USER_EMAILS,
  KEEP_ACTIVE_EMAILS,
  RESERVED_SLUGS,
  SOURCE_ORG_SLUG,
  guardFailures,
  isExecuteMode,
  partitionUsers,
  roleMappingErrors,
} from '../prisma/migrate-agency'

// Pure-logic tests for the one-time agency migration script. The script's DB
// phases only run when invoked directly via tsx (guarded on argv[1]), so
// importing it here is side-effect free.

const CLEAN_GUARD_INPUT = {
  existingSlugs: [SOURCE_ORG_SLUG],
  duplicateEmails: [] as string[],
  connectorCredentialCount: 0,
}

describe('isExecuteMode', () => {
  it('requires the exact literal "yes"', () => {
    expect(isExecuteMode('yes')).toBe(true)
    expect(isExecuteMode('YES')).toBe(false)
    expect(isExecuteMode('true')).toBe(false)
    expect(isExecuteMode('1')).toBe(false)
    expect(isExecuteMode('')).toBe(false)
    expect(isExecuteMode(undefined)).toBe(false)
  })
})

describe('guardFailures', () => {
  it('passes on a clean pre-migration database', () => {
    expect(guardFailures(CLEAN_GUARD_INPUT)).toEqual([])
  })

  it.each(RESERVED_SLUGS)('aborts when the reserved slug "%s" already exists', (slug) => {
    const failures = guardFailures({ ...CLEAN_GUARD_INPUT, existingSlugs: [SOURCE_ORG_SLUG, slug] })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(`"${slug}" already exists`)
  })

  it('aborts when the source meridian org is missing', () => {
    const failures = guardFailures({ ...CLEAN_GUARD_INPUT, existingSlugs: ['some-other-org'] })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(`"${SOURCE_ORG_SLUG}" not found`)
  })

  it('aborts on duplicate emails (login is org-blind)', () => {
    const failures = guardFailures({ ...CLEAN_GUARD_INPUT, duplicateEmails: ['dup@example.com'] })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('dup@example.com')
  })

  it('aborts when ConnectorCredential rows exist', () => {
    const failures = guardFailures({ ...CLEAN_GUARD_INPUT, connectorCredentialCount: 2 })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('2 ConnectorCredential')
  })

  it('accumulates every failure so the operator sees the full picture', () => {
    const failures = guardFailures({
      existingSlugs: ['prodigyflo', 'cys'],
      duplicateEmails: ['a@b.co'],
      connectorCredentialCount: 1,
    })
    // 2 reserved slugs + missing meridian + duplicates + credentials
    expect(failures).toHaveLength(5)
  })
})

describe('partitionUsers', () => {
  const u = (email: string, isActive = true) => ({ email, isActive })

  it('routes the three real users to moveToAgency', () => {
    const users = AGENCY_USER_EMAILS.map((e) => u(e))
    const { moveToAgency, keepActive, deactivate } = partitionUsers(users)
    expect(moveToAgency.map((x) => x.email)).toEqual([...AGENCY_USER_EMAILS])
    expect(keepActive).toEqual([])
    expect(deactivate).toEqual([])
  })

  it('keeps the investor demo login active in place, not moved', () => {
    const { moveToAgency, keepActive, deactivate } = partitionUsers([u('demo@leadrecoveryflow.app')])
    expect(moveToAgency).toEqual([])
    expect(keepActive.map((x) => x.email)).toEqual(['demo@leadrecoveryflow.app'])
    expect(deactivate).toEqual([])
  })

  it('deactivates every other active user — even ones with real logins', () => {
    const { deactivate } = partitionUsers([
      u('super@meridian.example'),
      u('admin@meridian.example'),
      u('client@meridian.example'),
    ])
    expect(deactivate).toHaveLength(3)
  })

  it('leaves already-inactive non-keep-list users out of the deactivate set', () => {
    const { moveToAgency, keepActive, deactivate } = partitionUsers([u('old@meridian.example', false)])
    expect(moveToAgency).toEqual([])
    expect(keepActive).toEqual([])
    expect(deactivate).toEqual([])
  })

  it('matches emails case-insensitively', () => {
    const { moveToAgency, keepActive } = partitionUsers([
      u('Hycama@Gmail.com'),
      u('DEMO@leadrecoveryflow.app'),
    ])
    expect(moveToAgency).toHaveLength(1)
    expect(keepActive).toHaveLength(1)
  })

  it('keep-list is a superset of the agency movers', () => {
    for (const email of AGENCY_USER_EMAILS) {
      expect(KEEP_ACTIVE_EMAILS).toContain(email)
    }
  })
})

describe('roleMappingErrors', () => {
  const AGENCY = 'org_agency'
  const moved = (over: Partial<Parameters<typeof roleMappingErrors>[0][number]> = {}) => ({
    email: 'hycama@gmail.com',
    organizationId: AGENCY,
    roleKey: 'SUPER_ADMIN',
    roleOrganizationId: AGENCY,
    expectedRoleKey: 'SUPER_ADMIN',
    ...over,
  })

  it('passes when the user and role both land in the agency org with the same key', () => {
    expect(roleMappingErrors([moved()], AGENCY)).toEqual([])
  })

  it('flags a user left in the wrong organization', () => {
    const errors = roleMappingErrors([moved({ organizationId: 'org_scs' })], AGENCY)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not the agency org')
  })

  it('flags a role belonging to another organization (schema does not enforce this)', () => {
    const errors = roleMappingErrors([moved({ roleOrganizationId: 'org_scs' })], AGENCY)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('role belongs to org')
  })

  it('flags a role key that changed during the move', () => {
    const errors = roleMappingErrors([moved({ roleKey: 'ADMIN' })], AGENCY)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('role key changed')
  })
})
