import 'server-only'
import {selectCohort} from '@/lib/intake/cohort'
import type {Prisma} from '@prisma/client'
import {db} from '@/lib/db'
/** Acknowledge a new invocation before it runs the next bounded stage. Cron recovers a failed dispatch. */
export async function requestRecordsContinuation(scope:{documentId?:string;clientId?:string}) {
  const token=process.env.JOBS_TOKEN??process.env.CRON_SECRET
  const origin=process.env.RECORDS_JOB_BASE_URL??(process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}`:null)
  if(!token||!origin) return {scheduled:false,reason:'Continuation endpoint not configured; durable cron recovery active'}
  const due=scope.documentId&&process.env.DOCUMENT_ANALYZER==='records'?await db.recordsAnalysisJob.findFirst({where:{documentId:scope.documentId,status:{in:['PENDING','WORKING']},nextAttemptAt:{lte:new Date()}}}):null
  let importsAllowed=false
  let importScope:Prisma.ExternalDocumentImportWhereInput={}
  try {
    const cohort=selectCohort(process.env.SCS_IMPORT_EXECUTION_COHORT,process.env.SCS_DOCUMENT_IMPORTS_PAUSED==='true')
    importsAllowed=cohort!==null&&!(process.env.SCS_IMPORT_REQUIRE_COHORT==='true'&&cohort===undefined)
    if(cohort) importScope={organizationId:cohort.organizationId,intakeSubmission:{sourceId:cohort.sourceId},OR:cohort.cases.map(c=>({sourceLeadId:c.leadId,sourceDocumentId:{in:c.documentIds}}))}
  } catch { /* invalid or expired cohort is not runnable */ }
  const imports=scope.clientId&&importsAllowed?await db.externalDocumentImport.count({where:{AND:[importScope,{clientId:scope.clientId,OR:[{status:{in:['PENDING','FAILED']},attempts:{lt:8}},{status:'IMPORTED',analysisPending:true,analysisAttempts:{lt:3},analysisNextAttemptAt:{lte:new Date()}}]}]}}):0
  const property=scope.clientId&&process.env.PROPERTY_RECORDS_PROVIDER==='records'?await db.propertyRecordsJob.findFirst({where:{clientId:scope.clientId,status:'PENDING'}}):null
  if(!due&&!imports&&!property) return {scheduled:false,reason:'No immediately due work'}
  const bypass=process.env.PF_VERCEL_PROTECTION_BYPASS??process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  const url=new URL('/api/internal/records/run',origin)
  if(url.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(url.hostname))) throw Error('Continuation requires HTTPS')
  try {
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(bypass?{'x-vercel-protection-bypass':bypass}:{})},body:JSON.stringify(scope),redirect:'manual',signal:AbortSignal.timeout(10_000)})
    if(!response.ok) throw Error(`Continuation refused (${response.status})`)
    return {scheduled:true}
  } catch(error) {console.error('[records] continuation dispatch failed; durable cron will recover',error instanceof Error?error.message:'Unknown dispatch error');return {scheduled:false}}
}
