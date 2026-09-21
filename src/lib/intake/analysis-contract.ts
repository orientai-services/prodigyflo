import {createHash} from 'node:crypto'
import {z} from 'zod'
import {asRecord, str} from '@/lib/packet/schema'
import {canonicalize} from './mapping'

export const analysisEvidence=z.object({value:z.string().nullable(),confidence:z.enum(['high','medium','low']),page:z.number().int().positive().nullable(),quote:z.string().nullable(),document_id:z.string(),source:z.string(),run_id:z.string(),provider:z.literal('records'),model:z.string().nullable(),staff_review_required:z.boolean(),alternatives:z.array(z.unknown()).optional()})
export const analysisDocument=z.object({documentId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),fields:z.record(z.string(),analysisEvidence),classification:z.array(z.string()),readableAgreement:z.boolean(),clientMatch:z.enum(['matched','unclear','unrelated']),coverage:z.object({complete:z.literal(true),totalPages:z.number().int().positive(),processedPages:z.number().int().positive()}),runs:z.array(z.string()).min(1),summary:z.string().optional(),reviewDecisions:z.record(z.string(),z.unknown()).optional()}).passthrough()
export const analysisMetadata=z.object({version:z.literal('records.v1'),manifestId:z.string().uuid(),status:z.string(),sourceLeadId:z.string(),manifest_version:z.number().int().positive(),evidence_revision:z.number().int().nonnegative(),analysis_version:z.string().min(1),identity_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),source_identity:z.object({first_name:z.string(),last_name:z.string(),address_line1:z.string(),city:z.string(),state:z.string(),zip:z.string()})})
export const analysisPacket=analysisMetadata.extend({documents:z.array(analysisDocument),jobs:z.array(z.unknown()).optional(),records:z.unknown().optional()})
export type AnalysisPacket=z.infer<typeof analysisPacket>
export const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** JSONB may reorder object keys. Evidence equality must preserve values and array order. */
export const evidenceHash=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex')
export function identityFromAnswers(raw:unknown) {
  const p=asRecord(raw), a=asRecord(asRecord(p.data).stage1_answers??p.stage1_answers)
  return Object.fromEntries(['first_name','last_name','address_line1','city','state','zip'].map(k=>[k,str(k==='address_line1'?a.property_street??a.address_line1:a[k]).trim().toLowerCase()]))
}
/** Total order for evidence, independent of the delivery ID or customer activity timestamp. */
export function compareAnalysisRevision(incoming:unknown,previous:unknown):number {
  const a=asRecord(incoming),b=asRecord(previous)
  if(!b.version) return 1
  if(!a.version) return -1
  const av=Number(a.manifest_version),bv=Number(b.manifest_version)
  if(!Number.isSafeInteger(av)||!Number.isSafeInteger(bv)) throw Error('Analysis manifest revision is missing')
  if(av!==bv) return Math.sign(av-bv)
  if(a.manifestId!==b.manifestId) throw Error('Analysis manifest revision has conflicting identities')
  const ar=Number(a.evidence_revision),br=Number(b.evidence_revision)
  if(!Number.isSafeInteger(ar)||!Number.isSafeInteger(br)) throw Error('Analysis evidence revision is missing')
  if(ar===br&&(a.identity_fingerprint!==b.identity_fingerprint||a.analysis_version!==b.analysis_version)) throw Error('Same analysis revision has conflicting identity/version')
  return Math.sign(ar-br)
}
export function validateAnalysis(value:unknown,sourceLeadId:string,rawPayload:unknown):AnalysisPacket {
  const packet=analysisPacket.parse(value)
  if(packet.sourceLeadId!==sourceLeadId) throw Error('Analysis belongs to a different SCS case')
  if(hash(packet.source_identity)!==packet.identity_fingerprint || hash(identityFromAnswers(rawPayload))!==packet.identity_fingerprint) throw Error('Analysis identity does not match current contact/property')
  const ids=new Set<string>()
  for(const doc of packet.documents) {
    if(ids.has(doc.documentId)) throw Error('Duplicate analysis document')
    ids.add(doc.documentId)
    if(doc.coverage.totalPages!==doc.coverage.processedPages) throw Error('Incomplete analysis coverage')
    for(const f of Object.values(doc.fields)) {
      if(f.document_id!==doc.documentId || !doc.runs.includes(f.run_id) || f.page!==null&&f.page>doc.coverage.totalPages) throw Error('Analysis evidence is outside its document/run')
    }
  }
  return packet
}


/** Evidence sequencing is authoritative even when contact activity is unchanged. */
export function shouldSkipScsPacket(incoming:unknown,previous:unknown,completed:boolean):boolean {
  const a=asRecord(incoming),b=asRecord(previous),ad=asRecord(a.data),bd=asRecord(b.data)
  if(ad.analysis||bd.analysis) {
    const order=compareAnalysisRevision(ad.analysis,bd.analysis)
    if(order!==0) return order<0
  }
  const time=(d:Record<string,unknown>)=>{const t=Date.parse(str(d.last_activity_at));return Number.isFinite(t)?t:null}
  const newer=time(ad),older=time(bd)
  return older!==null&&(newer===null||newer<older)||completed&&newer===older&&typeof a.id==='string'&&a.id===b.id
}
