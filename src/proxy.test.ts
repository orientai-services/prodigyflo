import {afterEach,describe,it,expect,vi} from 'vitest'
import {NextRequest} from 'next/server'
import {proxy} from './proxy'
afterEach(()=>vi.unstubAllEnvs())
describe('bearer-auth continuation through the session proxy',()=>{
 it('lets the exact continuation route reach its own auth without a session cookie',()=>{
  vi.stubEnv('PRODIGYFLO_MAINTENANCE','false')
  const response=proxy(new NextRequest('https://preview.test/api/internal/records/run',{method:'POST'}))
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('location')).toBeNull()
 })
 it('does not expose neighboring internal routes',()=>{
  vi.stubEnv('PRODIGYFLO_MAINTENANCE','false')
  for(const path of ['/api/internal/records/other','/api/internal/records/run/admin']) {
   const response=proxy(new NextRequest(`https://preview.test${path}`))
   expect(response.status).toBe(307);expect(response.headers.get('location')).toContain('/login')
  }
 })
 it('continues pausing service work during an explicit maintenance cutover',()=>{
  vi.stubEnv('PRODIGYFLO_MAINTENANCE','true')
  expect(proxy(new NextRequest('https://preview.test/api/internal/records/run')).status).toBe(503)
 })
})
