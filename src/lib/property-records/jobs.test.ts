import {afterEach,describe,it,expect,vi} from 'vitest'
vi.mock('@/lib/db',()=>({db:{}}))
vi.mock('@/lib/storage',()=>({getFileStorage:vi.fn()}))
vi.mock('@/lib/intake/scs-document-requirements',()=>({scsRequirementId:vi.fn()}))
vi.mock('@/lib/intake/synthetic',()=>({isSyntheticClient:vi.fn()}))
import type {Prisma} from '@prisma/client'
import {db} from '@/lib/db'
import {addressVersion,normalizeAddress,type PropertyAddress} from './contract'
import {queuePropertyRecords,runPropertyRecordsJobs} from './jobs'
const A={line1:'4416 Clear Brook Pl',city:'Las Vegas',state:'NV',postal_code:'89103'},B={...A,line1:'4417 Clear Brook Pl'}
type Job={id:string;clientId:string;addressVersion:string;status:string;attempts:number;result:unknown;importedFiles:Record<string,unknown>}
type Doc={id:string;clientId:string;status:string;updatedAt:Date}
function fixture(){
 let address=A
 const jobs:Job[]=[],documents:Doc[]=[]
 const store={
  $queryRaw:vi.fn(),clientAddress:{findFirst:async()=>({...address,postalCode:address.postal_code})},
  propertyRecordsJob:{
   findMany:async({where}:{where:{clientId:string;addressVersion:{not:string};status:{not:string}}})=>jobs.filter(j=>j.clientId===where.clientId&&j.addressVersion!==where.addressVersion.not&&j.status!==where.status.not),
   upsert:async({where,create}:{where:{clientId_addressVersion:{clientId:string;addressVersion:string}};create:Partial<Job>})=>{const found=jobs.find(j=>j.clientId===where.clientId_addressVersion.clientId&&j.addressVersion===where.clientId_addressVersion.addressVersion);if(found)return found;const job={id:`job${jobs.length}`,clientId:'client',addressVersion:'',status:'PENDING',attempts:0,result:null,importedFiles:{},...create};jobs.push(job);return job},
   update:async({where,data}:{where:{id:string};data:Partial<Job>})=>{const job=jobs.find(j=>j.id===where.id);Object.assign(job!,data);return job},
  },
  clientDocument:{
   findFirst:async({where}:{where:{id:string;clientId:string}})=>documents.find(d=>d.id===where.id&&d.clientId===where.clientId),
   update:async({where,data}:{where:{id:string};data:Partial<Doc>})=>{const d=documents.find(d=>d.id===where.id);Object.assign(d!,data);return d},
   updateMany:async({where,data}:{where:{id:string;clientId:string;status:string;updatedAt:Date};data:Partial<Doc>})=>{const d=documents.find(d=>d.id===where.id&&d.clientId===where.clientId&&d.status===where.status&&d.updatedAt.getTime()===where.updatedAt.getTime());if(d)Object.assign(d,data);return {count:d?1:0}},
  },
 }
 return {jobs,documents,store:store as unknown as Prisma.TransactionClient,queue:async(a:typeof A)=>{address=a;return queuePropertyRecords({organizationId:'org',clientId:'client',address:a},store as unknown as Prisma.TransactionClient)}}
}
describe('property address lifecycle',()=>{
 it('requeues A after A → B → A with the same provider receipt identity',async()=>{
  const f=fixture(),a=await f.queue(A);await f.queue(B)
  expect(a.status).toBe('SUPERSEDED')
  const again=await f.queue(A)
  expect(again.id).toBe(a.id);expect(again.status).toBe('PENDING');expect(again.attempts).toBe(0)
  expect(f.jobs.filter(j=>j.status==='PENDING')).toHaveLength(1)
 })
 it('expires completed old-property originals, keeps provenance, restores same-property review',async()=>{
  const f=fixture(),a=await f.queue(A)
  Object.assign(a,{status:'COMPLETED',result:{providerReceipt:'durable'},importedFiles:{hash:'doc1'}})
  const doc={id:'doc1',clientId:'client',status:'APPROVED',updatedAt:new Date(0),requirementId:'deed',storageKey:'original'};f.documents.push(doc)
  await f.queue(B)
  expect(a.status).toBe('SUPERSEDED');expect(doc.status).toBe('EXPIRED');expect(doc.storageKey).toBe('original')
  expect((a.importedFiles as Record<string,unknown>).hash).toMatchObject({id:'doc1',priorStatus:'APPROVED'})
  await f.queue(A)
  expect(a.result).toEqual({providerReceipt:'durable'});expect(doc.status).toBe('APPROVED')
 })
 it('does not overwrite staff rejection made while original was historical',async()=>{
  const f=fixture(),a=await f.queue(A);Object.assign(a,{status:'COMPLETED',importedFiles:{hash:'doc1'}})
  const doc={id:'doc1',clientId:'client',status:'APPROVED',updatedAt:new Date(0)};f.documents.push(doc)
  await f.queue(B);doc.status='REJECTED';doc.updatedAt=new Date();await f.queue(A)
  expect(doc.status).toBe('REJECTED')
 })
 it('refuses queueing an address that is not the live primary property',async()=>{
  const f=fixture()
  await expect(queuePropertyRecords({organizationId:'org',clientId:'client',address:B},f.store)).rejects.toThrow('current primary address')
 })
})

const BARTONA:PropertyAddress={line1:'909 bartona st',city:'las vegas',state:'nv',postal_code:'89107'}
const savedEnv=new Map<string,string|undefined>()
function setEnv(name:string,value:string){if(!savedEnv.has(name))savedEnv.set(name,process.env[name]);process.env[name]=value}
afterEach(()=>{for(const [name,value] of savedEnv){if(value===undefined)delete process.env[name];else process.env[name]=value};savedEnv.clear();vi.unstubAllGlobals();vi.restoreAllMocks()})

function runner(attempts=0,result:unknown=null){
  const address=normalizeAddress(BARTONA)
  const job={id:'job-1',clientId:'client-1',organizationId:'org',caseKey:'case-1',addressVersion:addressVersion(address),address,status:'RUNNING',attempts,result,importedFiles:{},claimedAt:new Date('2026-10-03T12:00:00.000Z'),error:null as string|null}
  const queries:string[]=[]
  const live={line1:address.line1,city:address.city,state:address.state,postalCode:address.postal_code}
  const tx={$queryRaw:async()=>[],clientAddress:{findFirst:async()=>live},propertyRecordsJob:{updateMany:async()=>({count:1}),findUniqueOrThrow:async()=>job},clientDocument:{findMany:async()=>[]}}
  Object.assign(db,{
    $queryRaw:vi.fn(async(strings:TemplateStringsArray)=>{queries.push(strings.join(' '));return [{id:job.id}]}),
    $transaction:async(fn: (store:typeof tx)=>unknown)=>fn(tx),
    propertyRecordsJob:{findUniqueOrThrow:async()=>job,updateMany:async({data}:{data:Record<string,unknown>})=>{
      const bump=data.attempts as {increment?:number}|undefined
      if(bump&&typeof bump==='object'&&typeof bump.increment==='number') job.attempts+=bump.increment
      if(typeof data.status==='string') job.status=data.status
      if('error' in data) job.error=data.error as string|null
      return {count:1}
    }},
    clientAddress:{findFirst:async()=>live},
    clientDocument:{findMany:async()=>[]},
  })
  setEnv('PROPERTY_RECORDS_PROVIDER','records')
  setEnv('RECORDS_ANALYZER_URL','https://records.example.test')
  setEnv('RECORDS_ANALYZER_KEY','test-key')
  const lines:string[]=[]
  vi.spyOn(console,'log').mockImplementation(message=>{if(typeof message==='string'&&message.includes('property_records_job')) lines.push(message)})
  return {job,queries,lines}
}
function uccResult(){
  const address=normalizeAddress(BARTONA)
  return {version:'property-records-v1',case_key:'case-1',address_version:addressVersion(address),address,parcel:{id:'138-36-413-004',address,source_url:'https://example.test/parcel'},status:'partial',outcomes:[{source:'clark_recorder',kind:'ucc',status:'recorder_record_summary'}],originals:[{url:'https://records.example.test/api/service/originals/abc',sha256:'a'.repeat(64),mime:'application/pdf',filename:'clark-ucc-201910160000384-2019-10-16.pdf',category:'ucc',source_url:'https://recorderecomm.clarkcountynv.gov/AcclaimWeb/Document/DocDetails',provenance:'recorder_record_summary',record_key:'ucc:201910160000384'}],cached:false}
}
function finish(lines:string[]){expect(lines).toHaveLength(1);const row=JSON.parse(lines[0]);expect(row.event).toBe('property_records_job');expect(JSON.stringify(row)).not.toMatch(/bartona|138-36|ARRIETA|PARAMOUNT/i);return row}

describe('property records job failures',()=>{
  it('fails a down service with Records service unreachable and keeps the 10 minute claim',async()=>{
    const f=runner()
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}})}))
    const counts=await runPropertyRecordsJobs()
    expect(counts).toMatchObject({failed:1})
    expect(f.job.status).toBe('FAILED')
    expect(f.job.error).toBe('Records service unreachable')
    expect(f.job.attempts).toBe(1)
    expect(f.queries[0]).toContain("interval '10 minutes'")
    expect(f.queries[0]).toContain("status='RUNNING'")
    expect(f.queries[0]).toContain('attempts<3')
    const row=finish(f.lines)
    expect(row).toMatchObject({job_id:'job-1',client_id:'client-1',doc_type:'none',outcome:'FAILED',reason:'Records service unreachable',attempts:1,started_at:'2026-10-03T12:00:00.000Z'})
    expect(row.finished_at).toEqual(expect.any(String))
  })
  it('names a missing lookup endpoint',async()=>{
    const f=runner()
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404})))
    await runPropertyRecordsJobs()
    expect(f.job.status).toBe('FAILED')
    expect(f.job.error).toBe('Records service endpoint not found (404)')
    expect(finish(f.lines).reason).toBe('Records service endpoint not found (404)')
  })
  it('names an expired record file separately from a missing endpoint',async()=>{
    const f=runner(0,uccResult())
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:404,body:null})))
    await runPropertyRecordsJobs()
    expect(f.job.status).toBe('FAILED')
    expect(f.job.error).toBe('Record file expired on service')
    expect(finish(f.lines)).toMatchObject({doc_type:'ucc',outcome:'FAILED',reason:'Record file expired on service',attempts:1})
  })
  it('pauses on the third failure of a reclaimed running job',async()=>{
    const f=runner(2)
    vi.stubGlobal('fetch',vi.fn(async()=>{const error=new Error('The operation was aborted due to timeout');error.name='TimeoutError';throw error}))
    await runPropertyRecordsJobs()
    expect(f.job.status).toBe('PAUSED')
    expect(f.job.attempts).toBe(3)
    expect(f.job.error).toBe('Records service unreachable')
    expect(f.queries[0]).toContain("interval '10 minutes'")
    expect(finish(f.lines)).toMatchObject({outcome:'PAUSED',attempts:3,reason:'Records service unreachable'})
  })
})
