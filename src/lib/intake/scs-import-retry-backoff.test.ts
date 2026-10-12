import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({
  db: {
    externalDocumentImport: { findMany: m.findMany, updateMany: m.updateMany, count: m.count },
    recordsAnalysisJob: { findFirst: vi.fn(async () => null) },
    propertyRecordsJob: { findFirst: vi.fn(async () => null) },
  },
}))
vi.mock('@/lib/storage', () => ({ getFileStorage: () => ({}) }))
vi.mock('@/lib/extraction/run', () => ({ runExtraction: vi.fn() }))
vi.mock('./scs-document-requirements', () => ({ scsRequirementId: vi.fn() }))

import { FAILED_RETRY_BACKOFF_MS, runPendingScsDocumentImports } from './scs-document-import'
import { requestRecordsContinuation } from '@/lib/records-analyzer/continuation'

type Row = { status: string; attempts: number; updatedAt: Date; clientId: string }
// Minimal evaluator for the Prisma where shapes used by these two queries.
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (v as Record<string, unknown>[]).every(w => matches(row, w))
    if (k === 'OR') return (v as Record<string, unknown>[]).some(w => matches(row, w))
    const field = (row as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const c = v as { in?: unknown[]; lt?: number | Date; lte?: Date }
      if (c.in && !c.in.includes(field)) return false
      if (c.lt !== undefined && !((field as number) < (c.lt as number))) return false
      if (c.lte !== undefined && !((field as number) <= (c.lte as unknown as number))) return false
      return true
    }
    return field === v
  })
}

const recentFailed: Row = { status: 'FAILED', attempts: 1, updatedAt: new Date(Date.now() - 30_000), clientId: 'client_1' }
const oldFailed: Row = { ...recentFailed, updatedAt: new Date(Date.now() - FAILED_RETRY_BACKOFF_MS - 60_000) }
const pending: Row = { ...recentFailed, status: 'PENDING', attempts: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.SCS_IMPORT_EXECUTION_COHORT
  delete process.env.SCS_IMPORT_REQUIRE_COHORT
  delete process.env.SCS_DOCUMENT_IMPORTS_PAUSED
})

describe('SCS import retry backoff (R-GOV-013)', () => {
  it('does not pick up a FAILED row updated under 2 minutes ago', async () => {
    m.findMany.mockResolvedValue([])
    await runPendingScsDocumentImports(5, undefined, 'client_1')
    const where = m.findMany.mock.calls[0][0].where
    expect(matches(recentFailed, where)).toBe(false)
    expect(matches(oldFailed, where)).toBe(true)
    expect(matches(pending, where)).toBe(true)
    expect(matches({ ...oldFailed, attempts: 8 }, where)).toBe(false)
  })

  it('continuation does not count a FAILED import as due work, so it does not self-chain', async () => {
    process.env.JOBS_TOKEN = 't'
    process.env.RECORDS_JOB_BASE_URL = 'https://pf.example'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    m.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      [recentFailed, oldFailed].filter(r => matches(r, where)).length)
    const out = await requestRecordsContinuation({ clientId: 'client_1' })
    expect(out).toMatchObject({ scheduled: false })
    expect(fetchSpy).not.toHaveBeenCalled()
    m.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      [pending].filter(r => matches(r, where)).length)
    expect(await requestRecordsContinuation({ clientId: 'client_1' })).toMatchObject({ scheduled: true })
    fetchSpy.mockRestore()
  })
})
