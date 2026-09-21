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
export const recordsResult=z.object({version:z.literal('property-records-v1'),case_key:z.string(),address_version:z.string(),address:addressSchema,
  parcel:z.object({id:z.string(),address:addressSchema,source_url:z.string()}).nullable(),
  status:z.enum(['complete','partial','no_match','unsupported','paused']),
  outcomes:z.array(z.object({source:z.string(),kind:z.enum(['parcel','permit','deed','ucc']),status:z.enum(['original','index_only','no_match','unsupported','failed','budget_paused']),source_url:z.string().optional(),detail:z.string().optional()})),
  originals:z.array(z.object({url:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime:z.string(),filename:z.string(),category:z.enum(['deed','ucc','permit']),source_url:z.string()})),cached:z.boolean()})
export function validateRecordsResult(raw:unknown,caseKey:string,address:PropertyAddress) {
  const result=recordsResult.parse(raw)
  if(result.case_key!==caseKey||result.address_version!==addressVersion(address)||addressVersion(result.address)!==addressVersion(address)) throw Error('Public records response belongs to another case/property version')
  if(result.parcel&&addressVersion(result.parcel.address)!==addressVersion(address)) throw Error('Matched parcel address does not match the requested property')
  if(result.originals.length&&!result.parcel?.id) throw Error('Original records require a matched parcel')
  for(const file of result.originals) if(!result.outcomes.some(o=>o.kind===file.category&&o.status==='original')) throw Error('Original record has no supported retrieval outcome')
  return result
}
