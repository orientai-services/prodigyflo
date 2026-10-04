import {createHash} from 'node:crypto'
import {z} from 'zod'
export const addressSchema=z.object({line1:z.string().min(1),city:z.string().min(1),state:z.string().min(2),postal_code:z.string().min(5)})
export type PropertyAddress=z.infer<typeof addressSchema>
const streetWords:Record<string,string>={street:'st',avenue:'ave',drive:'dr',road:'rd',place:'pl',court:'ct',lane:'ln',boulevard:'blvd',circle:'cir',parkway:'pkwy',north:'n',south:'s',east:'e',west:'w',apartment:'unit',apt:'unit'}
const canonicalStreet=(s:string)=>s.toLowerCase().replace(/#/g,' unit ').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean).map(w=>streetWords[w]??w).join(' ')
const normalize=(s:string)=>s.trim().toLowerCase().replace(/[.,]/g,'').replace(/\s+/g,' ')
export function normalizeAddress(address:PropertyAddress):PropertyAddress {
  const a=addressSchema.parse(address)
  return {line1:canonicalStreet(a.line1),city:normalize(a.city),state:normalize(a.state),postal_code:a.postal_code.trim().slice(0,5)}
}
export function addressVersion(address:PropertyAddress) {return createHash('sha256').update(JSON.stringify(normalizeAddress(address))).digest('hex')}
/** Why a permit lookup filed no document. The records service sends one of these with status no_permit_found. */
export const PERMIT_REASONS=['no_solar_permit','outside_service_area','needs_human_check','login_required','lookup_failed'] as const
export const PERMIT_REASON_TEXT:Record<typeof PERMIT_REASONS[number],string>={no_solar_permit:'no solar permit on record',outside_service_area:'outside service area',needs_human_check:'needs human check',login_required:'portal needs a login',lookup_failed:'lookup failed'}
export const recordsResult=z.object({version:z.literal('property-records-v1'),case_key:z.string(),address_version:z.string(),address:addressSchema,
  parcel:z.object({id:z.string(),address:addressSchema,source_url:z.string()}).nullable(),
  status:z.enum(['complete','partial','no_match','unsupported','paused']),
  outcomes:z.array(z.object({source:z.string(),kind:z.enum(['parcel','permit','deed','ucc']),status:z.enum(['original','index_only','no_match','unsupported','failed','budget_paused','assessor_copy','recorder_record_summary','permit_record_page','no_permit_found']),reason:z.enum(PERMIT_REASONS).optional(),retry_after:z.string().datetime().optional(),source_url:z.string().optional(),detail:z.string().optional()})),
  originals:z.array(z.object({url:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime:z.string(),filename:z.string(),category:z.enum(['deed','ucc','permit']),source_url:z.string(),provenance:z.enum(['assessor_copy','recorder_record_summary','city_permit','recorder_unofficial_copy','original','permit_record_page']).optional(),record_key:z.string().regex(/^(deed|ucc|permit):[A-Za-z0-9:._-]{1,160}$/).optional(),amendment_only:z.boolean().optional()})),cached:z.boolean()})
export type RecordsOriginal=z.infer<typeof recordsResult>['originals'][number]
export const AMENDMENT_ONLY_LABEL='amendment only, original not on index'
/** Tile label for a recorder summary. An index with no original financing statement says so. */
export function uccTileLabel(file:{category:string;provenance?:string|null;amendment_only?:boolean|null}) {
  if(file.category!=='ucc'||file.provenance!=='recorder_record_summary') return null
  return file.amendment_only?AMENDMENT_ONLY_LABEL:'County record summary (not the filing)'
}
export const PERMIT_RECORD_PAGE_LABEL='Permit record page (not the permit document)'
/** Tile label for a permit portal screenshot, used when the portal offers no permit PDF. */
export function permitTileLabel(file:{category:string;provenance?:string|null}) {
  return file.category==='permit'&&file.provenance==='permit_record_page'?PERMIT_RECORD_PAGE_LABEL:null
}
/** Staff-facing line for a permit lookup that filed no document. Null when a permit file was filed or the result is unreadable. */
export function permitStatusNote(result:unknown):string|null {
  const outcomes=(result as {outcomes?:unknown})?.outcomes
  if(!Array.isArray(outcomes)) return null
  const permit=outcomes.find((o:unknown)=>(o as {kind?:unknown})?.kind==='permit') as {status?:string;reason?:string;detail?:string}|undefined
  if(!permit) return null
  const reason=permit.reason&&permit.reason in PERMIT_REASON_TEXT?PERMIT_REASON_TEXT[permit.reason as keyof typeof PERMIT_REASON_TEXT]:null
  // The service's detail opens with 'no permit found — <headline>:'; a source-specific headline beats the generic reason text.
  const headline=permit.detail?.match(/^no permit found — ([^:]{3,120}):/i)?.[1]?.trim()
  if(permit.status==='no_permit_found') return `No permit found — ${headline??reason??'see records detail'}`
  const legacy:Record<string,string>={no_match:'no solar permit on record',unsupported:'outside service area',failed:'lookup failed',budget_paused:'lookup paused'}
  return legacy[permit.status??'']?`No permit found — ${legacy[permit.status!]}`:null
}
/** Stable filing identity. The same instrument or attachment keeps one key when the PDF bytes change. */
export function filingIdentity(file:{category:string;filename:string;record_key?:string|null}) {
  const key=file.record_key?.trim()
  return (key||`${file.category}:${file.filename.trim()}`).slice(0,180)
}
/** A live document is the same filing when its key matches exactly, or when an older row has the same filename and no key yet. */
export function isSameFiling(existing:{fileName:string|null;internalComment:string|null},incoming:{category:string;filename:string;record_key?:string|null}) {
  const identity=filingIdentity(incoming)
  const tagged=(existing.internalComment??'').match(/record_key:\s*(\S+)/)
  if(tagged) return tagged[1]===identity
  return Boolean(existing.fileName)&&existing.fileName===incoming.filename.slice(0,255)
}
type RecordFile={category:'deed'|'ucc'|'permit';provenance?:'assessor_copy'|'recorder_record_summary'|'city_permit'|'recorder_unofficial_copy'|'original'|'permit_record_page'}
type RecordOutcome={kind:'parcel'|'permit'|'deed'|'ucc';status:string}
/** Deed assessor images, UCC recorder screenshots and permit record-page screenshots are the only non-original files this desk accepts. */
function outcomeSupports(file:RecordFile,outcomes:RecordOutcome[]) {
  if(file.category==='deed'&&file.provenance==='assessor_copy') return outcomes.some(o=>o.kind==='deed'&&(o.status==='assessor_copy'||o.status==='original'))
  if(file.category==='ucc'&&file.provenance==='recorder_record_summary') return outcomes.some(o=>o.kind==='ucc'&&o.status==='recorder_record_summary')
  if(file.category==='permit'&&file.provenance==='permit_record_page') return outcomes.some(o=>o.kind==='permit'&&o.status==='permit_record_page')
  return outcomes.some(o=>o.kind===file.category&&o.status==='original')
}
export function validateRecordsResult(raw:unknown,caseKey:string,address:PropertyAddress) {
  const result=recordsResult.parse(raw)
  if(result.case_key!==caseKey||result.address_version!==addressVersion(address)||addressVersion(result.address)!==addressVersion(address)) throw Error('Public records response belongs to another case/property version')
  if(result.parcel&&addressVersion(result.parcel.address)!==addressVersion(address)) throw Error('Matched parcel address does not match the requested property')
  if(result.originals.length&&!result.parcel?.id) throw Error('Original records require a matched parcel')
  for(const file of result.originals) if(!outcomeSupports(file,result.outcomes)) throw Error('Original record has no supported retrieval outcome')
  return result
}
