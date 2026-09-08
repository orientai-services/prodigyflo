import { describe, expect, it } from 'vitest'
import {
  findDuplicates,
  mergeIncoming,
  normaliseEmail,
  normalisePhone,
  type DedupeDb,
  type DuplicateCandidate,
} from '@/lib/dedupe'

describe('normaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Maria.Lopez@Example.COM ')).toBe('maria.lopez@example.com')
  })
  it('handles null and undefined', () => {
    expect(normaliseEmail(null)).toBe('')
    expect(normaliseEmail(undefined)).toBe('')
  })
})

describe('normalisePhone', () => {
  it('keeps the last 10 digits', () => {
    expect(normalisePhone('+1 (702) 555-0134')).toBe('7025550134')
    expect(normalisePhone('17025550134')).toBe('7025550134')
  })
  it('leaves short numbers alone', () => {
    expect(normalisePhone('555-0134')).toBe('5550134')
  })
  it('handles empty input', () => {
    expect(normalisePhone(null)).toBe('')
    expect(normalisePhone('ext.')).toBe('')
  })
})

function stubDb(candidates: DuplicateCandidate[]): DedupeDb {
  return { client: { findMany: async () => candidates } }
}

const maria: DuplicateCandidate = {
  id: 'c1',
  firstName: 'Maria',
  lastName: 'Lopez',
  email: 'maria@example.com',
  phone: '(702) 555-0134',
  addresses: [{ postalCode: '89101' }],
}

describe('findDuplicates', () => {
  it('matches on email regardless of case and whitespace', async () => {
    const result = await findDuplicates(stubDb([maria]), 'org1', { email: ' MARIA@Example.com ' })
    expect(result.exact).toHaveLength(1)
    expect(result.exact[0].matchedOn).toBe('email')
  })

  it('matches on phone across formatting differences', async () => {
    const result = await findDuplicates(stubDb([maria]), 'org1', { phone: '+1 702-555-0134' })
    expect(result.exact).toHaveLength(1)
    expect(result.exact[0].matchedOn).toBe('phone')
  })

  it('reports name + postal as a possible, not exact, match', async () => {
    const result = await findDuplicates(stubDb([maria]), 'org1', {
      firstName: 'maria',
      lastName: 'LOPEZ',
      postalCode: '89101',
      email: 'different@example.com',
      phone: '7020000000',
    })
    expect(result.exact).toHaveLength(0)
    expect(result.possible).toHaveLength(1)
    expect(result.possible[0].matchedOn).toBe('name_postal')
  })

  it('does not report name+postal when postal differs', async () => {
    const result = await findDuplicates(stubDb([maria]), 'org1', {
      firstName: 'Maria',
      lastName: 'Lopez',
      postalCode: '89102',
    })
    expect(result.exact).toHaveLength(0)
    expect(result.possible).toHaveLength(0)
  })

  it('prefers the email classification when both email and phone match', async () => {
    const result = await findDuplicates(stubDb([maria]), 'org1', {
      email: 'maria@example.com',
      phone: '7025550134',
    })
    expect(result.exact).toHaveLength(1)
    expect(result.exact[0].matchedOn).toBe('email')
  })

  it('returns nothing when there is nothing to match on', async () => {
    let called = false
    const db: DedupeDb = {
      client: {
        findMany: async () => {
          called = true
          return []
        },
      },
    }
    const result = await findDuplicates(db, 'org1', {})
    expect(result).toEqual({ exact: [], possible: [] })
    expect(called).toBe(false)
  })
})

describe('mergeIncoming', () => {
  it('never overwrites a non-empty field with an empty one', () => {
    const existing = { firstName: 'Maria', phone: '7025550134', email: 'maria@example.com' }
    const incoming = { firstName: '', phone: '   ', email: 'new@example.com' }
    expect(mergeIncoming(existing, incoming)).toEqual({ email: 'new@example.com' })
  })

  it('fills empty existing fields from incoming', () => {
    const existing = { firstName: 'Maria', utmSource: '' }
    expect(mergeIncoming(existing, { utmSource: 'facebook' })).toEqual({ utmSource: 'facebook' })
  })

  it('skips values that are already identical', () => {
    const existing = { firstName: 'Maria', lastName: 'Lopez' }
    expect(mergeIncoming(existing, { firstName: 'Maria', lastName: 'Lopez' })).toEqual({})
  })

  it('ignores null and undefined incoming values', () => {
    const existing = { firstName: 'Maria', lastName: 'Lopez' }
    expect(
      mergeIncoming(existing, { firstName: null as unknown as string, lastName: undefined }),
    ).toEqual({})
  })
})
