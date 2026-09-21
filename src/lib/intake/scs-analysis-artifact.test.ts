import {afterEach,describe,it,expect,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {resolveScsAnalysisArtifact} from './scs-analysis-artifact'
const metadata={version:'records.v1',manifestId:'85f579ea-4d96-4c82-8ebc-3f10b56d401f',status:'results_available',sourceLeadId:'lead',manifest_version:1,evidence_revision:2,analysis_version:'v2',identity_fingerprint:'a'.repeat(64),source_identity:{first_name:'a',last_name:'b',address_line1:'1 main',city:'vegas',state:'nv',zip:'89103'}}
const full={...metadata,documents:[]},bytes=Buffer.from(JSON.stringify(full)),sha256=createHash('sha256').update(bytes).digest('hex')
const input={data:{analysis:{...metadata,artifact:{url:`https://scs.test/api/internal/prodigyflo/analysis/${metadata.manifestId}?sha256=${sha256}`,bytes:bytes.length,sha256}}}}
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function setup(){vi.stubEnv('SCS_DOCUMENT_EXPORT_BASE_URL','https://scs.test');vi.stubEnv('SCS_DOCUMENT_EXPORT_TOKEN','test-token')}
describe('private analysis artifact import',()=>{
 it('authenticates fixed host, rejects redirects, validates bytes before parsing',async()=>{
  setup();const fetch=vi.fn().mockResolvedValue(new Response(bytes));vi.stubGlobal('fetch',fetch)
  expect(await resolveScsAnalysisArtifact(input)).toEqual({data:{analysis:full}})
  expect(fetch.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{'X-SCS-Export-Token':'test-token'}})
 })
 it('rejects a credential-exfiltrating URL without sending a request',async()=>{
  setup();const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  await expect(resolveScsAnalysisArtifact({data:{analysis:{...input.data.analysis,artifact:{...input.data.analysis.artifact,url:input.data.analysis.artifact.url.replace('scs.test','evil.test')}}}})).rejects.toThrow('Untrusted')
  expect(fetch).not.toHaveBeenCalled()
 })
 it('rejects different bytes and oversized streams',async()=>{
  setup();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('different')))
  await expect(resolveScsAnalysisArtifact(input)).rejects.toThrow('checksum')
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(Buffer.alloc(bytes.length+1))))
  await expect(resolveScsAnalysisArtifact(input)).rejects.toThrow('declared size')
 })
})
