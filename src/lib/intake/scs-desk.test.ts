import { describe, expect, it } from 'vitest'
import { SCS_INTAKE_SLUG, deskVisibleClientWhere } from './scs-desk'

describe('deskVisibleClientWhere', () => {
  it('requires SCS intake slug scs-website or an SCS packet import', () => {
    expect(SCS_INTAKE_SLUG).toBe('scs-website')
    const where = deskVisibleClientWhere()
    const json = JSON.stringify(where)
    expect(json).toContain('scs-website')
    expect(json).toContain('intakeSubmissions')
    expect(json).toContain('externalDocumentImports')
    expect(where.OR).toHaveLength(2)
  })
})
