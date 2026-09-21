import {describe,it,expect,vi} from 'vitest'
vi.mock('@/lib/db',()=>({db:{}}))
vi.mock('@/lib/storage',()=>({getFileStorage:vi.fn()}))
vi.mock('@/lib/intake/scs-document-requirements',()=>({scsRequirementId:vi.fn()}))
vi.mock('@/lib/intake/synthetic',()=>({isSyntheticClient:vi.fn()}))
import type {Prisma} from '@prisma/client'
import {queuePropertyRecords} from './jobs'
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
