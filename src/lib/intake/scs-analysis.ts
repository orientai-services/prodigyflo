import 'server-only'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {Prisma} from '@prisma/client'
import {db} from '@/lib/db'
import {specForType} from '@/lib/extraction/spec'
import {asRecord,str} from '@/lib/packet/schema'

import {analysisDocument as document,validateAnalysis,compareAnalysisRevision,hash,evidenceHash} from './analysis-contract'

export async function queueAnalysisPacket(opts:{organizationId:string;clientId:string;sourceLeadId:string;analysis:unknown;rawPayload:unknown},store:Prisma.TransactionClient=db) {
  if(opts.analysis==null) return // older schema42 packets remain compatible
  const analysis=validateAnalysis(opts.analysis,opts.sourceLeadId,opts.rawPayload)
  // Retain historical runs/corrections but remove their automatic suggestions
  // immediately when a new manifest/identity starts processing.
  await store.documentExtraction.updateMany({where:{provider:'records',document:{externalImport:{is:{clientId:opts.clientId,sourceLeadId:opts.sourceLeadId}}},sourceEvidence:{path:['manifestId'],not:analysis.manifestId}},data:{sourceActive:false}})
  await store.externalDocumentImport.updateMany({where:{clientId:opts.clientId,sourceLeadId:opts.sourceLeadId,sourceAnalysis:{path:['manifestId'],not:analysis.manifestId}},data:{analysisPending:false}})
  for(const doc of analysis.documents) {
    if(doc.coverage.totalPages!==doc.coverage.processedPages) throw Error('Incomplete analysis coverage')
    if(Object.values(doc.fields).some(f=>f.document_id!==doc.documentId || f.page!==null&&f.page>doc.coverage.totalPages)) throw Error('Analysis evidence does not belong to its document')
    const receipt=await store.externalDocumentImport.findFirst({where:{organizationId:opts.organizationId,clientId:opts.clientId,sourceLeadId:opts.sourceLeadId,sourceDocumentId:doc.documentId}})
    if(!receipt) throw Error('Analysis document was not included in this client’s imported file manifest')
    const previous=asRecord(receipt.sourceAnalysis)
    const order=compareAnalysisRevision(analysis,previous)
    if(order<0) continue
    const payload={...doc,manifestId:analysis.manifestId,manifest_version:analysis.manifest_version,evidence_revision:analysis.evidence_revision,version:analysis.version,identity_fingerprint:analysis.identity_fingerprint,analysis_version:analysis.analysis_version,source_identity:analysis.source_identity,sourceLeadId:analysis.sourceLeadId}
    if(order===0&&evidenceHash(payload)!==evidenceHash(previous)) throw Error('Same analysis revision has different evidence')
    const identity=createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    if(receipt.analysisIdentity!==identity) await store.externalDocumentImport.update({where:{id:receipt.id},data:{sourceAnalysis:payload as Prisma.InputJsonValue,analysisIdentity:identity,analysisPending:true,analysisError:null,analysisAttempts:0,analysisNextAttemptAt:new Date()}})
  }
}
const KEYS:Record<string,string>={agreement_type:'product_type',customer_signed_date:'customer_signed_date',effective_date:'contract_date',in_service_date:'in_service_date',first_payment_date:'first_payment_date',installer:'installer_name',sales_company:'sales_company',lender_servicer:'contract_counterparty',system_size:'system_size_kw',interest_rate:'apr',escalator_rate:'escalator_pct',annual_escalation_rate:'escalator_pct',monthly_solar_payment:'monthly_payment',first_year_monthly_payment:'first_year_monthly_payment',intro_payment_count:'intro_payment_count',payment_basis:'payment_basis',remaining_balance:'remaining_balance',interest_paid_to_date:'interest_paid_to_date',months_remaining:'months_remaining',years_remaining:'years_remaining',total_financed:'amount_financed',finance_account_number:'account_number',production_kwh:'production_kwh',signer_name:'full_name',address_line1:'property_address',utility_account_number:'account_number',annual_usage_kwh:'annual_usage_kwh',monthly_usage_kwh:'monthly_usage_kwh',kwh:'annual_usage_kwh',production_guarantee:'production_guarantee',buyout_terms:'buyout_terms',balloon_amount:'balloon_amount',term_start_basis:'term_start_basis',account_number:'account_number',full_name:'full_name',customer_name:'full_name',property_address:'property_address',service_address:'service_address',utility_name:'utility_name',utility:'utility_name',lender_name:'lender_name',servicer:'servicer_name',servicer_name:'servicer_name',contract_counterparty:'contract_counterparty',term_years:'term_years',payment_term_months:'term_months',dealer_fee:'dealer_fee',cash_price:'cash_price',monthly_utility_bill:'amount_due',billing_period:'billing_period'}
const LOAN_KINDS=new Set(['loan','til','loan_statement','loan_or_til','ric'])
const SOLAR_KINDS=new Set(['agreement','ppa','lease','solar_contract','signed_contract','solar_agreement','power_purchase_agreement'])
export function typeFor(doc:z.infer<typeof document>) {
  const product=String(doc.fields.agreement_type?.value??'').toLowerCase()
  const kinds=doc.classification.map(k=>String(k).toLowerCase())
  const hay=`${kinds.join(' ')} ${product}`
  if(kinds.includes('utility_bill') || /utility_bill|electric(?:ity)?\s*bill/.test(hay)) return 'utility_bill'
  if(kinds.some(k=>LOAN_KINDS.has(k)) || /\bloan\b|\btil\b|\bric\b|installment/.test(product)) return 'finance_agreement'
  if(kinds.some(k=>SOLAR_KINDS.has(k)) || /\bppa\b|\blease\b|power purchase/.test(product)) return 'solar_contract'
  if(kinds.includes('ucc_or_lien') || kinds.includes('lien_filing')) return 'lien_filing'
  if(kinds.includes('permit') || kinds.includes('permits')) return 'permit'
  if(kinds.includes('monitoring') || kinds.includes('production')) return 'production_report'
  return 'other'
}
export async function materializeScsAnalysis(limit=20,scope:Prisma.ExternalDocumentImportWhereInput={}) {
  const rows=await db.externalDocumentImport.findMany({where:{AND:[scope,{status:'IMPORTED',analysisPending:true,analysisAttempts:{lt:3},analysisNextAttemptAt:{lte:new Date()},clientDocumentId:{not:null}}]},orderBy:{updatedAt:'asc'},take:limit,include:{clientDocument:true}})
  let applied=0,failed=0
  for(const row of rows) {
    if(!row.sourceAnalysis || !row.clientDocument) continue
    try {
    const doc=document.parse(row.sourceAnalysis)
    if(row.clientDocument.checksum!==doc.sha256) throw Error('Analysis checksum does not match the imported original')
    const identity=createHash('sha256').update(JSON.stringify(row.sourceAnalysis)).digest('hex')
    const source=asRecord(row.sourceAnalysis)
    const client=await db.client.findUniqueOrThrow({where:{id:row.clientId},include:{addresses:{where:{isPrimary:true},take:1}}})
    const address=client.addresses[0]
    const liveIdentity={first_name:client.firstName.trim().toLowerCase(),last_name:client.lastName.trim().toLowerCase(),address_line1:(address?.line1??'').trim().toLowerCase(),city:(address?.city??'').trim().toLowerCase(),state:(address?.state??'').trim().toLowerCase(),zip:(address?.postalCode??'').trim().toLowerCase()}
    if(hash(liveIdentity)!==source.identity_fingerprint) throw Error('Contact/property changed before evidence materialization')
    const type=typeFor(doc), spec=specForType(type)
    const fields=analysisFields(doc)
    const materialized=await db.$transaction(async store=>{
      await store.$queryRaw`SELECT id FROM "Client" WHERE id=${row.clientId} FOR UPDATE`
      await store.$queryRaw`SELECT id FROM "ExternalDocumentImport" WHERE id=${row.id} FOR UPDATE`
      const current=await store.externalDocumentImport.findUniqueOrThrow({where:{id:row.id}})
      if(current.analysisIdentity!==row.analysisIdentity || !current.analysisPending) return false
      const live=await store.client.findUniqueOrThrow({where:{id:row.clientId},include:{addresses:{where:{isPrimary:true},take:1}}})
      const a=live.addresses[0]
      if(hash({first_name:live.firstName.trim().toLowerCase(),last_name:live.lastName.trim().toLowerCase(),address_line1:(a?.line1??'').trim().toLowerCase(),city:(a?.city??'').trim().toLowerCase(),state:(a?.state??'').trim().toLowerCase(),zip:(a?.postalCode??'').trim().toLowerCase()})!==source.identity_fingerprint) throw Error('Contact/property changed during evidence materialization')
      await store.documentExtraction.updateMany({where:{documentId:row.clientDocumentId!,provider:'records',sourceIdentity:{not:identity}},data:{sourceActive:false}})
      const warnings=['Imported from the same private Records analysis; no second extraction.']
      const model=Object.values(doc.fields).find(f=>f.model)?.model??null
      await store.documentExtraction.upsert({where:{sourceIdentity:identity},update:{
        sourceActive:true,sourceEvidence:row.sourceAnalysis as Prisma.InputJsonValue,status:'COMPLETED',provider:'records',model,
        detectedTypeKey:type,detectedTypeLabel:spec.label,pageCount:doc.coverage.totalPages,summary:doc.summary,completedAt:new Date(),warnings,
      },create:{
        documentId:row.clientDocumentId!,sourceIdentity:identity,sourceEvidence:row.sourceAnalysis as Prisma.InputJsonValue,
        status:'COMPLETED',provider:'records',model,detectedTypeKey:type,detectedTypeLabel:spec.label,pageCount:doc.coverage.totalPages,
        summary:doc.summary,completedAt:new Date(),fields:{create:fields},warnings,
      }})
      const extraction=await store.documentExtraction.findUniqueOrThrow({where:{sourceIdentity:identity},include:{fields:true}})
      const locked=new Set(extraction.fields.filter(f=>['VERIFIED','CORRECTED','REJECTED'].includes(f.verification)).map(f=>f.key))
      await store.extractedField.deleteMany({where:{extractionId:extraction.id,verification:'UNVERIFIED'}})
      const incoming=fields.filter(f=>!locked.has(f.key))
      if(incoming.length) await store.extractedField.createMany({data:incoming.map(f=>({extractionId:extraction.id,...f}))})
      await store.externalDocumentImport.update({where:{id:row.id},data:{analysisPending:false,analysisError:null,analysisAttempts:0}})
      await store.clientDocument.updateMany({where:{id:row.clientDocumentId!,status:{notIn:['APPROVED','REJECTED','EXPIRED']}},data:{status:fields.some(f=>f.value)?'RECEIVED':'MISSING_INFORMATION'}})
      return true
    })
    if(!materialized) continue
    // Intake may have refreshed the mirror before this asynchronous import.
    // Resolve again from the committed current evidence; the mirror's atomic
    // conflict predicate preserves concurrent staff verification/corrections.
    await (await import('@/lib/cys/data')).refreshCysMirror(row.organizationId,row.clientId)
    applied++
    } catch(error) {
      failed++
      await db.externalDocumentImport.updateMany({where:{id:row.id,analysisIdentity:row.analysisIdentity},data:{analysisPending:row.analysisAttempts+1<3,analysisAttempts:{increment:1},analysisNextAttemptAt:new Date(Date.now()+30_000),analysisError:error instanceof Error?error.message:'Analysis evidence could not be imported'}})
    }
  }
  return {applied,failed}
}

/** Re-apply stored SCS analysis onto desk fields after mapping changes. */
export async function requeueImportedScsAnalysis(scope:Prisma.ExternalDocumentImportWhereInput={}) {
  const result=await db.externalDocumentImport.updateMany({
    where:{AND:[scope,{status:'IMPORTED',clientDocumentId:{not:null},NOT:{sourceAnalysis:{equals:Prisma.DbNull}}}]},
    data:{analysisPending:true,analysisAttempts:0,analysisError:null,analysisNextAttemptAt:new Date()},
  })
  return result.count
}

export function analysisFields(doc:z.infer<typeof document>) {
  const type=typeFor(doc),spec=specForType(type)
  return Object.entries(doc.fields).flatMap(([scsKey,f])=>{
      const key=scsKey==='lender_servicer' ? type==='solar_contract'?'contract_counterparty':'lender_name' : KEYS[scsKey]
      if(!key || scsKey==='utility_account_number'&&type!=='utility_bill') return []
      const same=Object.entries(doc.fields).find(([other])=>other!==scsKey&&KEYS[other]===key)
      if(same&&scsKey==='customer_name') return []
      const review=asRecord(doc.reviewDecisions?.[scsKey])
      const source=asRecord(review.source_evidence)
      const sources=[source,...(Array.isArray(source.alternatives)?source.alternatives.map(asRecord):[])]
      const bound=sources.some(s=>s.document_id===doc.documentId&&doc.runs.includes(str(s.run_id)))
      const edited=bound&&review.action==='edited', accepted=bound&&review.action==='accepted', rejected=review.action==='rejected'
      const extracted=f.value==null||f.value===''?null:String(f.value)
      const decided=review.action==='accepted'||review.action==='edited'||review.action==='rejected'
      // Bound accept/edit wins. Unreviewed Document Intelligence values still
      // land on the desk as unverified so loan/install tiles are not blank.
      const value=rejected||doc.clientMatch==='unclear'||(decided&&!bound)?null
        :(edited||accepted)&&typeof review.accepted==='string'?review.accepted.trim()||null
        :extracted
      return [{key,label:spec.fields.find(x=>x.key===key)?.label??key.replaceAll('_',' '),value,normalizedValue:value,
        confidence:f.confidence==='high'?90:f.confidence==='medium'?65:25,
        sourcePage:edited?null:f.page,sourceSnippet:edited?null:f.quote,verification:'UNVERIFIED' as const,
        conflictNote:f.alternatives?.length&&f.value===null?'Conflicting document values; choose or leave unknown.':null,
        reviewerNote:edited?'Customer corrected this value during SCS review; staff verification is still required.':accepted?'Customer accepted this value during SCS review; staff verification is still required.':rejected?'Customer marked this value unknown.':'Awaiting customer review; raw proposal remains in source evidence.'}]
    })
}
