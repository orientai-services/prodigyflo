import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest'
const mocks=vi.hoisted(()=>({after:vi.fn(),staff:vi.fn(),imports:vi.fn(),analysis:vi.fn(),property:vi.fn(),continuation:vi.fn()}))
vi.mock('next/server',()=>({after:mocks.after}))
vi.mock('@/lib/records-analyzer/staff-jobs',()=>({runStaffAnalysisJobs:mocks.staff}))
vi.mock('@/lib/records-analyzer/continuation',()=>({requestRecordsContinuation:mocks.continuation}))
vi.mock('@/lib/intake/scs-document-import',()=>({runPendingScsDocumentImports:mocks.imports,runPendingScsDocumentExtractions:mocks.analysis}))
vi.mock('@/lib/property-records/jobs',()=>({runPropertyRecordsJobs:mocks.property}))
import {POST} from './route'
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('JOBS_TOKEN','private-test-token');vi.stubEnv('CRON_SECRET','')})
afterEach(()=>vi.unstubAllEnvs())
describe('continuation route service auth',()=>{
 it('rejects missing or incorrect bearer without scheduling any work',async()=>{
  for(const token of ['', 'wrong']) {
   const response=await POST(new Request('https://preview.test/api/internal/records/run',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({clientId:'isolated-test-client'})}))
   expect(response.status).toBe(401)
  }
  expect(mocks.after).not.toHaveBeenCalled();expect(mocks.property).not.toHaveBeenCalled()
 })
 it('acknowledges authenticated exact-client continuation and keeps execution scoped',async()=>{
  const response=await POST(new Request('https://preview.test/api/internal/records/run',{method:'POST',headers:{Authorization:'Bearer private-test-token'},body:JSON.stringify({clientId:'isolated-test-client'})}))
  expect(response.status).toBe(202);expect(mocks.after).toHaveBeenCalledOnce()
  await mocks.after.mock.calls[0][0]()
  expect(mocks.imports).toHaveBeenCalledWith(1,undefined,'isolated-test-client')
  expect(mocks.analysis).toHaveBeenCalledWith(1,'isolated-test-client')
  expect(mocks.property).toHaveBeenCalledWith(1,'isolated-test-client')
  expect(mocks.continuation).toHaveBeenCalledWith({clientId:'isolated-test-client'})
 })
})
