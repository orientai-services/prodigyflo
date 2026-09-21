import {describe,it,expect} from 'vitest'
import {hash,validateAnalysis,compareAnalysisRevision,identityFromAnswers,shouldSkipScsPacket} from './analysis-contract'
const raw={lead_id:'lead1',data:{stage1_answers:{first_name:'Ashleigh',last_name:'Drew',property_street:'4416 Clear Brook Pl',city:'Las Vegas',state:'NV',zip:'89103'}}}
const identity=identityFromAnswers(raw)
const packet={version:'records.v1',manifestId:'85f579ea-4d96-4c82-8ebc-3f10b56d401f',status:'complete',sourceLeadId:'lead1',manifest_version:2,evidence_revision:1,analysis_version:'v2',source_identity:identity,identity_fingerprint:hash(identity),documents:[{documentId:'doc1',sha256:'a'.repeat(64),fields:{amount:{value:'10',confidence:'high',page:9,quote:'$10',document_id:'doc1',source:'source.pdf',run_id:'run1',provider:'records',model:'model',staff_review_required:true}},classification:['loan'],readableAgreement:true,clientMatch:'matched',coverage:{complete:true,totalPages:9,processedPages:9},runs:['run1']}]}
describe('SCS immutable analysis contract',()=>{
 it('accepts one nine-page document with matching contact and citations',()=>expect(validateAnalysis(packet,'lead1',raw).documents).toHaveLength(1))
 it('fences manifest and review revisions regardless of delivery time',()=>{
  expect(compareAnalysisRevision({...packet,manifest_version:1},packet)).toBe(-1)
  expect(compareAnalysisRevision({...packet,evidence_revision:0},packet)).toBe(-1)
  expect(compareAnalysisRevision({...packet,evidence_revision:2},packet)).toBe(1)
  expect(()=>compareAnalysisRevision({...packet,manifestId:'another'},packet)).toThrow('conflicting identities')
  expect(compareAnalysisRevision(undefined,packet)).toBe(-1)
 })
 it('rejects mismatched case/property identity',()=>{
  expect(()=>validateAnalysis(packet,'other',raw)).toThrow('different SCS case')
  expect(()=>validateAnalysis(packet,'lead1',{...raw,data:{stage1_answers:{...raw.data.stage1_answers,property_street:'Other address'}}})).toThrow('current contact/property')
 })
 it('rejects missing pages, outside citations, wrong run and duplicate documents',()=>{
  expect(()=>validateAnalysis({...packet,documents:[{...packet.documents[0],coverage:{complete:true,totalPages:9,processedPages:8}}]},'lead1',raw)).toThrow('Incomplete')
  for(const patch of [{page:10},{document_id:'other'},{run_id:'other'}]) expect(()=>validateAnalysis({...packet,documents:[{...packet.documents[0],fields:{amount:{...packet.documents[0].fields.amount,...patch}}}]},'lead1',raw)).toThrow('outside')
  expect(()=>validateAnalysis({...packet,documents:[packet.documents[0],packet.documents[0]]},'lead1',raw)).toThrow('Duplicate')
 })
})


describe('delivery dedupe uses evidence order first',()=>{
 const previous={id:'same-delivery',data:{analysis:packet,last_activity_at:'2026-09-20T15:00:00Z'}}
 it.each(['2026-09-20T14:00:00Z','2026-09-20T15:00:00Z'])('accepts newer evidence despite contact time %s and reused delivery ID',(time)=>{
  expect(shouldSkipScsPacket({id:'same-delivery',data:{analysis:{...packet,evidence_revision:2},last_activity_at:time}},previous,true)).toBe(false)
 })
 it('rejects older evidence despite newer contact time and new delivery ID',()=>expect(shouldSkipScsPacket({id:'another',data:{analysis:{...packet,evidence_revision:0},last_activity_at:'2026-09-21T15:00:00Z'}},previous,true)).toBe(true))
 it('continues deduplicating equal evidence retries and stale legacy packets',()=>{
  expect(shouldSkipScsPacket(previous,previous,true)).toBe(true)
  expect(shouldSkipScsPacket({id:'old',data:{last_activity_at:'2026-09-19T15:00:00Z'}},{id:'new',data:{last_activity_at:'2026-09-20T15:00:00Z'}},true)).toBe(true)
 })
})
