import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../src/proxy'
import { executionAuthorized } from '@/lib/intake/execution-auth'
import { readCohort, selectCohort } from '@/lib/intake/cohort'

const leadId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const cohort = () => ({ mode: 'synthetic', expiresAt: new Date(Date.now() + 60_000).toISOString(), cases: [{ leadId, documentIds: [documentId] }] })

describe('execution controls', () => {
  it('allows only the exact operator route past the session proxy', () => {
    expect(proxy(new NextRequest('http://localhost/api/internal/scs/execute')).headers.get('x-middleware-next')).toBe('1')
    expect(proxy(new NextRequest('http://localhost/api/internal/scs/other')).status).toBe(307)
  })

  it('keeps malformed, expired, and unapproved cohorts from selecting work', () => {
    for (const raw of ['', '{}', JSON.stringify({ ...cohort(), cases: [] }), JSON.stringify({ ...cohort(), expiresAt: '2000-01-01' })]) {
      expect(() => readCohort(raw)).toThrow()
    }
    expect(() => selectCohort(JSON.stringify(cohort()), true, { leadId: documentId })).toThrow()
    expect(selectCohort(JSON.stringify(cohort()), true, { leadId, documentId })?.cases).toEqual([{ leadId, documentIds: [documentId] }])
  })

  it('requires the existing strong Cron credential, not a temporary executor variable', () => {
    const old = process.env.CRON_SECRET
    try {
      delete process.env.CRON_SECRET
      expect(executionAuthorized(new Request('http://localhost'))).toBe(false)
      process.env.CRON_SECRET = 'x'.repeat(40)
      expect(executionAuthorized(new Request('http://localhost', { headers: { authorization: `Bearer ${'x'.repeat(40)}` } }))).toBe(true)
    } finally {
      if (old === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = old
    }
  })
})
