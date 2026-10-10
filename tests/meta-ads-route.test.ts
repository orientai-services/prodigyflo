import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { GET } from '@/app/api/jobs/meta-sync/route'

const req = (auth?: string) => new Request('http://localhost/api/jobs/meta-sync', { headers: auth ? { authorization: auth } : {} }) as unknown as NextRequest

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/jobs/meta-sync', () => {
  it('refuses without the cron secret, and when no secret is configured', async () => {
    vi.stubEnv('CRON_SECRET', '')
    vi.stubEnv('JOBS_TOKEN', '')
    expect((await GET(req('Bearer anything'))).status).toBe(401)
    vi.stubEnv('CRON_SECRET', 'cron-test-secret')
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('Bearer wrong'))).status).toBe(401)
  })

  it('answers counts only; nothing happens without a binding', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-test-secret')
    vi.stubEnv('META_ADS_ORG_ID', '')
    vi.stubEnv('META_ALLOWED_AD_ACCOUNTS', '')
    const res = await GET(req('Bearer cron-test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, adAccounts: 0, reason: 'not_configured' })
  })
})
