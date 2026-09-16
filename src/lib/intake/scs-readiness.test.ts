import { describe, expect, it } from 'vitest'
import { scsReadiness } from './scs-readiness'

describe('scsReadiness', () => {
  it('is silent for non-SCS clients', () => {
    expect(scsReadiness({ hasScsIntake: false, imports: [] })).toBeNull()
  })

  it('marks Step 1 receipt as Incomplete intake', () => {
    expect(scsReadiness({ hasScsIntake: true, imports: [] })).toBe('incomplete_intake')
  })

  it('marks the same case Assignable once an agreement exists', () => {
    expect(scsReadiness({
      hasScsIntake: true,
      imports: [{ sourceDocumentType: 'agreement', status: 'IMPORTED' }],
    })).toBe('assignable')
  })

  it('treats a finance instrument as enough', () => {
    expect(scsReadiness({
      hasScsIntake: true,
      imports: [{ sourceDocumentType: 'loan_or_til', status: 'PENDING' }],
    })).toBe('assignable')
  })

  it('ignores archived or failed files', () => {
    expect(scsReadiness({
      hasScsIntake: true,
      imports: [{ sourceDocumentType: 'agreement', status: 'ARCHIVED' }],
    })).toBe('incomplete_intake')
  })
})
