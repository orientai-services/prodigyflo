import 'server-only'
import {randomUUID} from 'node:crypto'
import {after} from 'next/server'
import {Prisma} from '@prisma/client'
import {db} from '@/lib/db'
import {getFileStorage} from '@/lib/storage'
import {isSyntheticClient} from '@/lib/intake/synthetic'
import {hash} from '@/lib/intake/analysis-contract'
import {analysisFields,typeFor} from '@/lib/intake/scs-analysis'
import type {ExtractionRunResult} from '@/lib/extraction/run'
import {prepareDocumentChunk,makeBatches,type BatchFile,type PreparedDocument} from './prepare'
import {advanceBatch} from './advance'
import {mapBatches, type AnalyzerBatchResult} from './map'
import {AnalyzerError,analyzerClient} from './client'

type Batch={id:string;files:BatchFile[];runId:string|null;uploaded:boolean;result?:unknown}
type State={sha256:string;batches:Batch[];prepared?:PreparedDocument;reconciliation?:unknown;identityFingerprint?:string}

export async function enqueueStaffAnalysis(documentId:string):Promise<ExtractionRunResult> {
  const doc=await db.clientDocument.findUniqueOrThrow({where:{id:documentId},include:{externalImport:true}})
  if(await isSyntheticClient(doc.clientId)) throw Error('Synthetic case: paid extraction blocked')
  if(!doc.storageKey || !doc.mimeType) throw Error('Document has no original file')
  // SCS files already have one owner for processing. Import its evidence instead.
  if(doc.externalImport) {
    const extraction=await db.documentExtraction.findFirst({where:{documentId,provider:'records',status:'COMPLETED'},orderBy:{createdAt:'desc'}})
    return {extractionId:extraction?.id??'',status:extraction?'COMPLETED':'PENDING',documentStatus:doc.status,missingFieldKeys:[],...(!extraction?{error:'Waiting for the original SCS analysis; no second extraction was started.'}:{})}
  }
  const job=await db.$transaction(async store=>{
    await store.$queryRaw`SELECT id FROM "ClientDocument" WHERE id=${documentId} FOR UPDATE`
    const existing=await store.recordsAnalysisJob.findUnique({where:{documentId}})
    if(existing) return existing
    const extraction=await store.documentExtraction.create({data:{documentId,provider:'records',status:'PENDING'}})
    await store.clientDocument.update({where:{id:documentId},data:{status:'PROCESSING'}})
    return store.recordsAnalysisJob.create({data:{documentId,extractionId:extraction.id}})
  })
  if(job.status==='PAUSED') return {extractionId:job.extractionId,status:'FAILED',documentStatus:doc.status,missingFieldKeys:[],error:job.error??'Analysis is paused; review the original and resolve the reported problem.'}
  try {after(async()=>{await runStaffAnalysisJobs(1,documentId);await (await import('./continuation')).requestRecordsContinuation({documentId})})} catch { /* durable cron handles non-request callers */ }
  return {extractionId:job.extractionId,status:job.status==='COMPLETED'?'COMPLETED':'PENDING',documentStatus:doc.status,missingFieldKeys:[]}
}

/** One bounded job step, with a durable claim; no transaction spans a model call. */
export async function runStaffAnalysisJobs(limit=1,documentId?:string) {
  const result={processed:0,failed:0}
  for(let i=0;i<limit;i++) {
    const token=randomUUID()
    const rows=await db.$queryRaw<{id:string}[]>`WITH due AS (
      SELECT id FROM "RecordsAnalysisJob" WHERE ("documentId"=${documentId??null} OR ${documentId??null}::text IS NULL)
        AND attempts<3 AND "nextAttemptAt"<=now() AND (status IN ('PENDING','WORKING','FAILED') OR status='RUNNING' AND "claimedAt"<now()-interval '10 minutes')
      ORDER BY "nextAttemptAt","createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE "RecordsAnalysisJob" j SET status='RUNNING',"claimedAt"=now(),"claimToken"=${token},"updatedAt"=now() FROM due WHERE j.id=due.id RETURNING j.id`
    if(!rows.length) break
    const job=await db.recordsAnalysisJob.findUniqueOrThrow({
      where:{id:rows[0].id},
      include:{document:{include:{client:{include:{addresses:{where:{isPrimary:true},take:1}}}}}},
    })
    const doc=job.document,storage=getFileStorage()
    try {
      if(await isSyntheticClient(doc.clientId)) throw Error('Synthetic case: paid extraction blocked')
      await db.documentExtraction.update({where:{id:job.extractionId},data:{status:'RUNNING',startedAt:new Date(),error:null}})
      const a=doc.client.addresses[0]
      const identityFingerprint=hash({first_name:doc.client.firstName.toLowerCase().trim(),last_name:doc.client.lastName.toLowerCase().trim(),address_line1:(a?.line1??'').toLowerCase().trim(),city:(a?.city??'').toLowerCase().trim(),state:(a?.state??'').toLowerCase().trim(),zip:(a?.postalCode??'').toLowerCase().trim()})
      let state=job.state as State|null
      if(state?.identityFingerprint&&state.identityFingerprint!==identityFingerprint) throw new AnalyzerError('Client identity or property changed; upload a new version for the current property.','identity_changed',409)
      if(!state || state.prepared?.complete===false) {
        const stored=new Map<string,string>()
        const prepared=await prepareDocumentChunk({id:doc.id,name:doc.fileName??'Document',mime:doc.mimeType!,bytes:await storage.get(doc.storageKey!)},async(key,bytes)=>{
          const saved=await storage.put(bytes,{fileName:key.split('/').at(-1)!,mimeType:'image/jpeg',clientId:doc.clientId});stored.set(key,saved.key)
        },state?.prepared,3)
        if(doc.checksum && doc.checksum!==prepared.sha256) throw Error('Original document checksum changed')
        prepared.pages=prepared.pages.map(p=>({...p,imageKey:stored.get(p.imageKey)??p.imageKey}))
        state={sha256:prepared.sha256,identityFingerprint,prepared,batches:prepared.complete?makeBatches([prepared]).map((files,n)=>({id:`${job.id}:${n}`,files,runId:null,uploaded:false})):[]}
        await db.recordsAnalysisJob.updateMany({where:{id:job.id,claimToken:token},data:{state:state as unknown as Prisma.InputJsonValue,status:'WORKING',claimedAt:null}})
        result.processed++;continue
      }
      const batch=state.batches.find(b=>!b.result)
      if(batch) {
        const source=await db.externalDocumentImport.findFirst({where:{clientId:doc.clientId,sourceLeadId:{not:null}},select:{sourceLeadId:true}})
        const caseKey=source?.sourceLeadId?`scs:${source.sourceLeadId}`:`pf:${doc.client.organizationId}:${doc.clientId}`
        const address=doc.client.addresses[0]
        const output=await advanceBatch(caseKey,batch,{first_name:doc.client.firstName,last_name:doc.client.lastName,address_line1:address?.line1,city:address?.city,state:address?.state,zip:address?.postalCode},key=>storage.get(key),async patch=>{
          Object.assign(batch,patch)
          await db.recordsAnalysisJob.updateMany({where:{id:job.id,claimToken:token},data:{state:state as unknown as Prisma.InputJsonValue}})
        })
        if(output.done) batch.result=output.result
      }
      if(state.batches.every(b=>b.result)) {
        if(!state.reconciliation&&state.batches.length>1) {
          const source=await db.externalDocumentImport.findFirst({where:{clientId:doc.clientId,sourceLeadId:{not:null}},select:{sourceLeadId:true}})
          const caseKey=source?.sourceLeadId?`scs:${source.sourceLeadId}`:`pf:${doc.client.organizationId}:${doc.clientId}`
          state.reconciliation=await analyzerClient(caseKey)('/case-reconcile',{method:'POST',requestId:`staff:${job.id}`,body:{runs:state.batches.map(b=>b.runId),manifestId:job.id,identity:{first_name:doc.client.firstName,last_name:doc.client.lastName}}})
          await db.recordsAnalysisJob.updateMany({where:{id:job.id,claimToken:token},data:{state:state as unknown as Prisma.InputJsonValue,status:'WORKING',claimedAt:null}})
          result.processed++;continue
        }
        const mapped=mapBatches(state.batches.map(b=>({files:b.files,result:b.result as AnalyzerBatchResult})),state.reconciliation as {fields?: AnalyzerBatchResult['fields']}|undefined)[0]
        if(!mapped || mapped.documentId!==doc.id || !mapped.coverage.complete) throw Error('Incomplete staff document coverage')
        const evidence={...mapped,sha256:state.sha256,coverage:{...mapped.coverage,complete:true as const}}
        const hint={sourceFileName:doc.fileName}
        const fields=analysisFields(evidence as Parameters<typeof analysisFields>[0],hint),type=typeFor(evidence as Parameters<typeof typeFor>[0],hint)
        await db.$transaction(async store=>{
          await store.$queryRaw`SELECT id FROM "Client" WHERE id=${doc.clientId} FOR UPDATE`
          await store.$queryRaw`SELECT id FROM "RecordsAnalysisJob" WHERE id=${job.id} FOR UPDATE`
          const current=await store.recordsAnalysisJob.findUniqueOrThrow({where:{id:job.id}})
          if(current.claimToken!==token) return
          const live=await store.client.findUniqueOrThrow({where:{id:doc.clientId},include:{addresses:{where:{isPrimary:true},take:1}}}),a=live.addresses[0]
          if(hash({first_name:live.firstName.toLowerCase().trim(),last_name:live.lastName.toLowerCase().trim(),address_line1:(a?.line1??'').toLowerCase().trim(),city:(a?.city??'').toLowerCase().trim(),state:(a?.state??'').toLowerCase().trim(),zip:(a?.postalCode??'').toLowerCase().trim()})!==state!.identityFingerprint) throw Error('Client changed before analysis publication')
          await store.documentExtraction.update({where:{id:job.extractionId},data:{status:'COMPLETED',provider:'records',sourceEvidence:evidence as unknown as Prisma.InputJsonValue,detectedTypeKey:type,summary:mapped.summary,pageCount:mapped.coverage.totalPages,completedAt:new Date(),error:null,fields:{create:fields}}})
          await store.clientDocument.updateMany({where:{id:doc.id,status:{notIn:['APPROVED','REJECTED','EXPIRED']}},data:{status:fields.some(f=>f.value)?'RECEIVED':'MISSING_INFORMATION'}})
          await store.recordsAnalysisJob.update({where:{id:job.id},data:{status:'COMPLETED',state:state as unknown as Prisma.InputJsonValue,claimedAt:null,error:null}})
        })
      } else await db.recordsAnalysisJob.updateMany({where:{id:job.id,claimToken:token},data:{status:'WORKING',state:state as unknown as Prisma.InputJsonValue,attempts:0,claimedAt:null,error:null}})
      result.processed++
    } catch(error) {
      const message=error instanceof Error?error.message:'Records analysis failed'
      const pause=job.attempts+1>=3 || error instanceof AnalyzerError&&['budget_paused','price_unverified','not_configured','analyzer_unavailable','analysis_paused','identity_changed'].includes(error.code)
      await db.recordsAnalysisJob.updateMany({where:{id:job.id,claimToken:token},data:{status:pause?'PAUSED':'FAILED',attempts:{increment:1},error:message,claimedAt:null,nextAttemptAt:new Date(Date.now()+30000)}})
      await db.documentExtraction.update({where:{id:job.extractionId},data:{status:'FAILED',error:message}})
      result.failed++
    }
  }
  return result
}


/** Explicit staff action resets local attempts and resumes the same remote stages. */
export async function resumeStaffAnalysis(documentId:string) {
  const imported=await db.externalDocumentImport.findFirst({where:{clientDocumentId:documentId,sourceAnalysis:{not:Prisma.DbNull}}})
  if(imported) {
    await db.externalDocumentImport.update({where:{id:imported.id},data:{analysisPending:true,analysisAttempts:0,analysisError:null,analysisNextAttemptAt:new Date()}})
    try {after(async()=>{await (await import('@/lib/intake/scs-analysis')).materializeScsAnalysis(1,{id:imported.id})})} catch { /* durable cron */ }
    return {extractionId:'',status:'PENDING' as const,documentStatus:'PROCESSING' as const,missingFieldKeys:[]}
  }
  const job=await db.recordsAnalysisJob.findUnique({where:{documentId}})
  if(!job) return enqueueStaffAnalysis(documentId)
  if(job.status==='COMPLETED') return enqueueStaffAnalysis(documentId)
  await db.recordsAnalysisJob.updateMany({where:{id:job.id,status:{in:['PAUSED','FAILED']}},data:{status:'PENDING',attempts:0,error:null,nextAttemptAt:new Date(),claimToken:null,claimedAt:null}})
  try {after(async()=>{await runStaffAnalysisJobs(1,documentId);await (await import('./continuation')).requestRecordsContinuation({documentId})})} catch { /* cron recovers durable state */ }
  return {extractionId:job.extractionId,status:'PENDING' as const,documentStatus:'PROCESSING' as const,missingFieldKeys:[]}
}
