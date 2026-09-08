import { describe, expect, it } from 'vitest'
import {
  isSwitchableTarget,
  signOrgSwitchGrant,
  verifyOrgSwitchGrant,
  type OrgSwitchGrant,
} from '@/lib/org-switch'

// Pure token tests — the secret and clock are injected, so nothing here reads
// process.env or the real time. Mirrors src/lib/stepup.test.ts.
const SECRET = 'test-org-switch-secret'
const NOW = 1_900_000_000

function grant(overrides: Partial<OrgSwitchGrant> = {}): OrgSwitchGrant {
  return { uid: 'user_1', orgId: 'org_child', exp: NOW + 3600, ...overrides }
}

describe('signOrgSwitchGrant / verifyOrgSwitchGrant', () => {
  it('round-trips a valid grant', () => {
    const token = signOrgSwitchGrant(grant(), SECRET)
    expect(verifyOrgSwitchGrant(token, { now: NOW, secretOverride: SECRET })).toEqual(grant())
  })

  it('rejects an expired grant', () => {
    const token = signOrgSwitchGrant(grant({ exp: NOW - 1 }), SECRET)
    expect(verifyOrgSwitchGrant(token, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('accepts a grant right at its expiry second', () => {
    const token = signOrgSwitchGrant(grant({ exp: NOW }), SECRET)
    expect(verifyOrgSwitchGrant(token, { now: NOW, secretOverride: SECRET })).not.toBeNull()
  })

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signOrgSwitchGrant(grant(), SECRET)
    const [, sig] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify(grant({ orgId: 'org_other' }))).toString('base64url')
    expect(verifyOrgSwitchGrant(`${forgedBody}.${sig}`, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = signOrgSwitchGrant(grant(), 'some-other-secret')
    expect(verifyOrgSwitchGrant(token, { now: NOW, secretOverride: SECRET })).toBeNull()
  })

  it('rejects grants with missing or mistyped fields', () => {
    for (const bad of [
      { uid: 'u', orgId: 'o' }, // no exp
      { uid: 'u', exp: NOW + 10 }, // no orgId
      { orgId: 'o', exp: NOW + 10 }, // no uid
      { uid: 1, orgId: 'o', exp: NOW + 10 }, // wrong type
      { uid: 'u', orgId: 'o', exp: 'soon' }, // wrong type
    ]) {
      // Properly signed, so the FIELD validation (not the signature) rejects it.
      const token = signOrgSwitchGrant(bad as never, SECRET)
      expect(verifyOrgSwitchGrant(token, { now: NOW, secretOverride: SECRET })).toBeNull()
    }
  })

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'nodot', 'a.b.c', 'not-base64!.sig', `${Buffer.from('"str"').toString('base64url')}.x`, `${Buffer.from('null').toString('base64url')}.x`]) {
      expect(verifyOrgSwitchGrant(bad, { now: NOW, secretOverride: SECRET })).toBeNull()
    }
  })
})

describe('isSwitchableTarget', () => {
  const agency = { id: 'org_agency', kind: 'AGENCY' }
  const clientHome = { id: 'org_client', kind: 'CLIENT' }
  const target = (overrides: Partial<{ id: string; parentOrganizationId: string | null; deletedAt: Date | null }> = {}) => ({
    id: 'org_child',
    parentOrganizationId: 'org_agency',
    deletedAt: null,
    ...overrides,
  })

  it('allows an agency user into a direct child', () => {
    expect(isSwitchableTarget(agency, target())).toBe(true)
  })

  it('allows an agency user back into its own home org', () => {
    expect(isSwitchableTarget(agency, target({ id: 'org_agency', parentOrganizationId: null }))).toBe(true)
  })

  it('refuses when the home org is not an agency', () => {
    expect(isSwitchableTarget(clientHome, target({ parentOrganizationId: 'org_client' }))).toBe(false)
  })

  it('refuses a deleted target', () => {
    expect(isSwitchableTarget(agency, target({ deletedAt: new Date() }))).toBe(false)
  })

  it("refuses an org that is not the agency's direct child", () => {
    expect(isSwitchableTarget(agency, target({ parentOrganizationId: 'org_other_agency' }))).toBe(false)
    expect(isSwitchableTarget(agency, target({ parentOrganizationId: null }))).toBe(false)
  })
})
