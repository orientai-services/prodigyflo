import {after} from 'next/server'
import {cronAuthorized} from '@/lib/cron-auth'
import {runStaffAnalysisJobs} from '@/lib/records-analyzer/staff-jobs'
import {requestRecordsContinuation} from '@/lib/records-analyzer/continuation'
import {runPendingScsDocumentImports,runPendingScsDocumentExtractions} from '@/lib/intake/scs-document-import'
import {runPropertyRecordsJobs} from '@/lib/property-records/jobs'
export const maxDuration=300
export async function POST(request:Request) {
  if(!cronAuthorized(request,[process.env.JOBS_TOKEN])) return Response.json({error:'Unauthorized'},{status:401})
  const scope=await request.json().catch(()=>null)
  if(!scope||(!scope.documentId&&!scope.clientId)||Object.keys(scope).some(k=>!['documentId','clientId'].includes(k))||Object.values(scope).some(v=>typeof v!=='string'||v.length>160)) return Response.json({error:'Exact document or client required'},{status:400})
  after(async()=>{
    if(scope.documentId) await runStaffAnalysisJobs(1,scope.documentId)
    if(scope.clientId) {await runPendingScsDocumentImports(1,undefined,scope.clientId);await runPendingScsDocumentExtractions(1,scope.clientId);await runPropertyRecordsJobs(1,scope.clientId)}
    await requestRecordsContinuation(scope)
  })
  return Response.json({accepted:true},{status:202})
}
