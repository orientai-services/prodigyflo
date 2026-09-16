import { describe, expect, it } from 'vitest'
import { scsRequirementFor } from './scs-document-requirements'

describe('scsRequirementFor', () => {
  it('maps homeowner upload types onto SCS upload areas', () => {
    expect(scsRequirementFor('ownership')?.key).toBe('property_ownership')
    expect(scsRequirementFor('permits')?.key).toBe('permit_records')
    expect(scsRequirementFor('lien_filing')?.key).toBe('lien_filing')
  })

  it('folds public-record packet kinds into the same upload areas', () => {
    expect(scsRequirementFor('public_record_deed')?.key).toBe('property_ownership')
    expect(scsRequirementFor('public_record_property')?.key).toBe('property_ownership')
    expect(scsRequirementFor('public_record_permit')?.key).toBe('permit_records')
    expect(scsRequirementFor('public_record_lien')?.key).toBe('lien_filing')
    expect(scsRequirementFor('public_record_ucc')?.key).toBe('lien_filing')
  })

  it('returns null for unknown or empty types', () => {
    expect(scsRequirementFor(null)).toBeNull()
    expect(scsRequirementFor('')).toBeNull()
    expect(scsRequirementFor('not_a_real_type')).toBeNull()
  })
})
