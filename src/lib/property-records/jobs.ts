import 'server-only'
import {randomUUID} from 'node:crypto'
import {Prisma, type DocumentStatus, type PropertyRecordsJob} from '@prisma/client'
import {db} from '@/lib/db'
import {getFileStorage} from '@/lib/storage'
import {sha256,validateUpload} from '@/lib/extraction/sniff'
import {scsRequirementId} from '@/lib/intake/scs-document-requirements'
import {isSyntheticClient} from '@/lib/intake/synthetic'
import {asRecord} from '@/lib/packet/schema'
import {addressVersion,normalizeAddress,validateRecordsResult,type PropertyAddress} from './contract'

type ImportedRecord={id:string; priorStatus?:DocumentStatus; suspendedAt?:string}
function importedRecord(value:unknown):ImportedRecord|null {
  if(typeof value==='string') return {id:value}
  const record=asRecord(value)
  return typeof record.id==='string'?record as ImportedRecord:null
}

export async function queuePropertyRecords(args:{organizationId:string;clientId:string;sourceLeadId?:string;address:PropertyAddress},store:Prisma.TransactionClient=db):Promise<PropertyRecordsJob> {
  if(store===db) return db.$transaction(tx=>queuePropertyRecords(args,tx))
  await store.$queryRaw`SELECT id FROM "Client" WHERE id=${args.clientId} FOR UPDATE`
  const address=normalizeAddress(args.address),version=addressVersion(address)
  const live=await store.clientAddress.findFirst({where:{clientId:args.clientId,isPrimary:true}})
  if(!live||addressVersion({line1:live.line1,city:live.city,state:live.state,postal_code:live.postalCode})!==version) throw Error('Property lookup request is not the current primary address')
  const previous=await store.propertyRecordsJob.findMany({where:{clientId:args.clientId,addressVersion:{not:version},status:{not:'SUPERSEDED'}}})
  for(const job of previous) {
    const files={...asRecord(job.importedFiles)}
    for(const [checksum,value] of Object.entries(files)) {
      const ref=importedRecord(value)
      if(!ref) continue
      const doc=await store.clientDocument.findFirst({where:{id:ref.id,clientId:args.clientId}})
      if(!doc||['REJECTED','EXPIRED'].includes(doc.status)) continue
      const priorStatus=doc.status
      const suspendedAt=new Date()
      await store.clientDocument.update({where:{id:doc.id},data:{status:'EXPIRED',updatedAt:suspendedAt}})
      files[checksum]={id:doc.id,priorStatus,suspendedAt:suspendedAt.toISOString()}
    }
    await store.propertyRecordsJob.update({where:{id:job.id},data:{status:'SUPERSEDED',claimToken:null,claimedAt:null,importedFiles:files as Prisma.InputJsonValue,error:'Property address changed; original records remain historical and cannot satisfy current-property requirements.'}})
  }
  const job=await store.propertyRecordsJob.upsert({where:{clientId_addressVersion:{clientId:args.clientId,addressVersion:version}},update:{},create:{organizationId:args.organizationId,clientId:args.clientId,caseKey:args.sourceLeadId?`scs:${args.sourceLeadId}`:`pf:${args.organizationId}:${args.clientId}`,addressVersion:version,address}})
  if(job.status!=='SUPERSEDED') return job
  // Reuse the original provider receipt/idempotency key and stored bytes. A
  // property revisit must not buy a duplicate lookup or discard review history.
  for(const value of Object.values(asRecord(job.importedFiles))) {
    const ref=importedRecord(value)
    if(!ref?.priorStatus||!ref.suspendedAt) continue
    await store.clientDocument.updateMany({where:{id:ref.id,clientId:args.clientId,status:'EXPIRED',updatedAt:new Date(ref.suspendedAt)},data:{status:ref.priorStatus}})
  }
  return store.propertyRecordsJob.update({where:{id:job.id},data:{status:'PENDING',attempts:0,claimToken:null,claimedAt:null,nextAttemptAt:new Date(),error:null}})
}

/** Result and file commits are fenced by the live primary address and claim. */
export async function runPropertyRecordsJobs(limit=1,clientId?:string) {
  const counts={completed:0,failed:0,paused:0}
  if(process.env.PROPERTY_RECORDS_PROVIDER!=='records') return {...counts,disabled:true}
  for(let i=0;i<limit;i++) {
    const token=randomUUID()
    const rows=await db.$queryRaw<{id:string}[]>`WITH due AS (
      SELECT id FROM "PropertyRecordsJob" WHERE ("clientId"=${clientId??null} OR ${clientId??null}::text IS NULL) AND attempts<3 AND "nextAttemptAt"<=now()
       AND (status IN ('PENDING','FAILED') OR status='RUNNING' AND "claimedAt"<now()-interval '10 minutes')
      ORDER BY "nextAttemptAt","createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE "PropertyRecordsJob" j SET status='RUNNING',"claimToken"=${token},"claimedAt"=now(),"updatedAt"=now() FROM due WHERE j.id=due.id RETURNING j.id`
    if(!rows.length) break
    const job=await db.propertyRecordsJob.findUniqueOrThrow({where:{id:rows[0].id}})
    try {
      if(await isSyntheticClient(job.clientId)) throw Error('Synthetic case: paid public-record lookup blocked')
      const origin=process.env.RECORDS_ANALYZER_URL,key=process.env.RECORDS_ANALYZER_KEY
      if(!origin||!key) throw Error('Private Records service is not configured')
      const base=new URL(origin)
      if(base.hostname==='records.prodigyflo.ai'||base.hostname.endsWith('.records.prodigyflo.ai')) throw Error('Private Records service is not configured')
      if(base.protocol!=='https:') throw Error('Private Records service is not configured')
      const headers={Authorization:`Bearer ${key}`,'x-analysis-case':job.caseKey,...(process.env.RECORDS_CF_ACCESS_CLIENT_ID&&process.env.RECORDS_CF_ACCESS_CLIENT_SECRET?{'CF-Access-Client-Id':process.env.RECORDS_CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':process.env.RECORDS_CF_ACCESS_CLIENT_SECRET}:{})}
      const address=normalizeAddress(job.address as PropertyAddress)
      const live=await db.clientAddress.findFirst({where:{clientId:job.clientId,isPrimary:true}})
      if(!live||addressVersion({line1:live.line1,city:live.city,state:live.state,postal_code:live.postalCode})!==job.addressVersion) {
        await db.propertyRecordsJob.updateMany({where:{id:job.id,claimToken:token},data:{status:'SUPERSEDED',claimToken:null,claimedAt:null,error:'Property changed before lookup execution'}})
        continue
      }
      const response=job.result?null:await fetch(new URL('/api/service/property-records',base),{method:'POST',headers:{...headers,'Content-Type':'application/json','idempotency-key':job.id},body:JSON.stringify({address,address_version:job.addressVersion}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(180_000)})
      if(response&&!response.ok) throw Error(`Records service returned ${response.status}`)
      const result=validateRecordsResult(job.result??await response!.json(),job.caseKey,address)
      const persisted=await db.$transaction(async tx=>{
        await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${job.clientId} FOR UPDATE`
        const currentAddress=await tx.clientAddress.findFirst({where:{clientId:job.clientId,isPrimary:true}})
        if(!currentAddress||addressVersion({line1:currentAddress.line1,city:currentAddress.city,state:currentAddress.state,postal_code:currentAddress.postalCode})!==job.addressVersion) return false
        const saved=await tx.propertyRecordsJob.updateMany({where:{id:job.id,claimToken:token,status:'RUNNING'},data:{result:result as Prisma.InputJsonValue}})
        return saved.count===1
      })
      if(!persisted) continue
      if(result.status==='paused') {await db.propertyRecordsJob.updateMany({where:{id:job.id,claimToken:token},data:{status:'PAUSED',claimedAt:null,error:'Records provider budget/configuration paused; staff action required.'}});counts.paused++;continue}
      for(const original of result.originals) {
        const latest=await db.propertyRecordsJob.findUniqueOrThrow({where:{id:job.id}})
        if(asRecord(latest.importedFiles)[original.sha256]) continue
        const url=new URL(original.url)
        if(url.origin!==base.origin||!url.pathname.startsWith('/api/service/originals/')||url.username||url.password) throw Error('Untrusted original record URL')
        const file=await fetch(url,{headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(55_000)})
        if(!file.ok||!file.body) throw Error(`Original record download failed (${file.status})`)
        const reader=file.body.getReader(),chunks:Uint8Array[]=[];let total=0
        try{while(true){const p=await reader.read();if(p.done)break;total+=p.value.byteLength;if(total>25*1024*1024)throw Error('Original record exceeds 25 MB');chunks.push(p.value)}}finally{await reader.cancel()}
        const bytes=Buffer.concat(chunks),validation=validateUpload({buffer:bytes,declaredMime:original.mime,maxSizeMb:25,allowedMimeTypes:[]})
        if(!validation.ok||sha256(bytes)!==original.sha256) throw Error('Original record failed format/checksum verification')
        const storage=getFileStorage(),saved=await storage.put(bytes,{fileName:original.filename,mimeType:validation.mimeType,clientId:job.clientId})
        const requirementId=await scsRequirementId(job.organizationId,`public_record_${original.category}`)
        let committed=false
        try {await db.$transaction(async tx=>{
          await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${job.clientId} FOR UPDATE`
          await tx.$queryRaw`SELECT id FROM "PropertyRecordsJob" WHERE id=${job.id} FOR UPDATE`
          const current=await tx.propertyRecordsJob.findUniqueOrThrow({where:{id:job.id}})
          const live=await tx.clientAddress.findFirst({where:{clientId:job.clientId,isPrimary:true}})
          if(current.claimToken!==token||current.status!=='RUNNING'||!live||addressVersion({line1:live.line1,city:live.city,state:live.state,postal_code:live.postalCode})!==job.addressVersion) throw Error('Property changed before original record import')
          if(asRecord(current.importedFiles)[original.sha256]) return
          const occupied=requirementId?await tx.clientDocument.findFirst({where:{clientId:job.clientId,requirementId,storageKey:{not:null},status:{notIn:['REJECTED','EXPIRED']}}}):null
          const doc=await tx.clientDocument.create({data:{clientId:job.clientId,requirementId:occupied?null:requirementId,fileName:original.filename.slice(0,255),label:`${original.category} — ${original.filename}`.slice(0,120),storageKey:saved.key,mimeType:validation.mimeType,sizeBytes:bytes.length,checksum:original.sha256,scanStatus:'clean',status:'RECEIVED',receivedAt:new Date(),internalComment:`Official original obtained via Records. Source: ${original.source_url}; parcel: ${result.parcel!.id}; address version: ${job.addressVersion}.`}})
          await tx.propertyRecordsJob.update({where:{id:job.id},data:{importedFiles:{...asRecord(current.importedFiles),[original.sha256]:doc.id} as Prisma.InputJsonValue}})
          committed=true
        })} finally {if(!committed)await storage.delete(saved.key)}
      }
      await db.$transaction(async tx=>{
        await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${job.clientId} FOR UPDATE`
        const live=await tx.clientAddress.findFirst({where:{clientId:job.clientId,isPrimary:true}})
        const active=live&&addressVersion({line1:live.line1,city:live.city,state:live.state,postal_code:live.postalCode})===job.addressVersion
        await tx.propertyRecordsJob.updateMany({where:{id:job.id,claimToken:token,status:'RUNNING'},data:{status:active?'COMPLETED':'SUPERSEDED',claimedAt:null,error:active?null:'Property address changed; result retained only as historical evidence.'}})
      })
      counts.completed++
    } catch(error) {
      const message=error instanceof Error?error.message:'Records lookup failed'
      await db.propertyRecordsJob.updateMany({where:{id:job.id,claimToken:token,status:'RUNNING'},data:{status:job.attempts+1>=3?'PAUSED':'FAILED',attempts:{increment:1},error:message,claimedAt:null,nextAttemptAt:new Date(Date.now()+30_000)}})
      counts.failed++
    }
  }
  return counts
}
