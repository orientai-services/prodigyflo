import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'

afterEach(() => vi.unstubAllEnvs())

describe('release maintenance', () => {
  it.each([
    ['GET', '/board'], ['POST', '/clients/client-id'],
    ['POST', '/api/intake/scs'], ['GET', '/api/jobs/run'],
    ['POST', '/api/internal/scs/execute'], ['POST', '/api/webhooks/calendly'],
    ['POST', '/api/documents/upload'], ['POST', '/api/auth/signin'],
  ])('pauses %s %s with a retryable, uncached response', (method, path) => {
    vi.stubEnv('PRODIGYFLO_MAINTENANCE', 'true')
    const response = proxy(new NextRequest('https://prodigyflo.ai' + path, { method }))
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('preserves the normal authentication and delivery routing after reopening', () => {
    vi.stubEnv('PRODIGYFLO_MAINTENANCE', 'false')
    expect(proxy(new NextRequest('https://prodigyflo.ai/board')).headers.get('location')).toContain('/login')
    expect(proxy(new NextRequest('https://prodigyflo.ai/api/intake/scs', { method: 'POST' })).headers.get('x-middleware-next')).toBe('1')
  })
})
