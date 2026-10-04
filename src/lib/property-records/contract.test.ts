import {describe,it,expect} from 'vitest'
import {addressVersion,AMENDMENT_ONLY_LABEL,filingIdentity,isSameFiling,PERMIT_RECORD_PAGE_LABEL,permitStatusNote,permitTileLabel,uccTileLabel,validateRecordsResult} from './contract'
const address={line1:'4416 Clear Brook Pl',city:'Las Vegas',state:'NV',postal_code:'89103'}
const result={version:'property-records-v1',case_key:'case1234',address_version:addressVersion(address),address,parcel:{id:'parcel-1',address,source_url:'https://county.test'},status:'partial',outcomes:[{source:'clark',kind:'deed',status:'index_only'}],originals:[],cached:false}
describe('property lookup identity and originals',()=>{
 it('normalizes contact spelling but does not accept different properties',()=>{
  expect(addressVersion({...address,line1:'  4416 CLEAR BROOK PL. ',postal_code:'89103-4206'})).toBe(addressVersion(address))
  expect(addressVersion({...address,line1:'4416 Clear Brook Place'})).toBe(addressVersion(address))
  expect(addressVersion({...address,line1:'4416 North Clear Brook Pl'})).not.toBe(addressVersion(address))
  expect(addressVersion({...address,line1:'4416 Clear Brook Pl #2'})).not.toBe(addressVersion(address))
  expect(()=>validateRecordsResult(result,'case1234',{...address,line1:'4417 Clear Brook Pl'})).toThrow('another case/property')
 })
 it('rejects a correct envelope with a different parcel address',()=>{
  expect(()=>validateRecordsResult({...result,parcel:{...result.parcel,address:{...address,line1:'4417 Clear Brook Pl'}}},'case1234',address)).toThrow('parcel address')
  expect(()=>validateRecordsResult({...result,parcel:{...result.parcel,address:{...address,city:'Henderson'}}},'case1234',address)).toThrow('parcel address')
 })
 it('keeps index-only separate from original retrieval',()=>expect(validateRecordsResult(result,'case1234',address).outcomes[0].status).toBe('index_only'))
 it('rejects fabricated originals without matching parcel/outcome',()=>{
  const original={url:'https://records.test/api/service/originals/hash',sha256:'a'.repeat(64),mime:'application/pdf',filename:'deed.pdf',category:'deed',source_url:'https://county.test'}
  expect(()=>validateRecordsResult({...result,originals:[original]},'case1234',address)).toThrow('no supported')
  expect(()=>validateRecordsResult({...result,parcel:null,originals:[original]},'case1234',address)).toThrow('matched parcel')
 })
 it('accepts an assessor deed copy and a recorder UCC summary, and still requires an original permit',()=>{
  const file=(category:string,provenance?:string)=>({url:'https://records.test/api/service/originals/hash',sha256:'a'.repeat(64),mime:'application/pdf',filename:`${category}.pdf`,category,source_url:'https://county.test',...(provenance?{provenance}:{})})
  const withParcel={...result,parcel:result.parcel,status:'partial'}
  expect(validateRecordsResult({...withParcel,outcomes:[{source:'clark',kind:'deed',status:'assessor_copy'}],originals:[file('deed','assessor_copy')]},'case1234',address).originals).toHaveLength(1)
  expect(validateRecordsResult({...withParcel,outcomes:[{source:'clark',kind:'ucc',status:'recorder_record_summary'}],originals:[file('ucc','recorder_record_summary')]},'case1234',address).originals[0].provenance).toBe('recorder_record_summary')
  expect(()=>validateRecordsResult({...withParcel,outcomes:[{source:'clark',kind:'permit',status:'no_match'}],originals:[file('permit','city_permit')]},'case1234',address)).toThrow('no supported')
  expect(()=>validateRecordsResult({...withParcel,outcomes:[{source:'clark',kind:'deed',status:'index_only'}],originals:[file('deed','assessor_copy')]},'case1234',address)).toThrow('no supported')
  expect(validateRecordsResult({...withParcel,outcomes:[{source:'clark',kind:'permit',status:'original'}],originals:[file('permit','city_permit')]},'case1234',address).originals[0].category).toBe('permit')
 })
 it('treats the same instrument as one filing even when the file bytes change',()=>{
  const deed={category:'deed',filename:'assessor-deed-2010052603910.pdf',record_key:'deed:20100526:03910'}
  expect(filingIdentity(deed)).toBe('deed:20100526:03910')
  expect(filingIdentity({category:'ucc',filename:'clark-recorder-summary-202103170002904.pdf'})).toBe('ucc:clark-recorder-summary-202103170002904.pdf')
  expect(isSameFiling({fileName:'assessor-deed-2010052603910.pdf',internalComment:'Official original obtained via Records.'},deed)).toBe(true)
  expect(isSameFiling({fileName:'assessor-deed-2010052603910.pdf',internalComment:'record_key: deed:20220125:02830 Official original.'},deed)).toBe(false)
  expect(isSameFiling({fileName:'other.pdf',internalComment:'record_key: deed:20100526:03910 kept'},deed)).toBe(true)
  expect(isSameFiling({fileName:'Building-Permit.pdf',internalComment:'record_key: permit:BOTH2019062934:file1'},{category:'permit',filename:'Building-Permit.pdf',record_key:'permit:BOTH2019062934'})).toBe(false)
  const parsed=validateRecordsResult({...result,parcel:result.parcel,outcomes:[{source:'clark',kind:'deed',status:'assessor_copy'}],originals:[{url:'https://records.test/api/service/originals/hash',sha256:'b'.repeat(64),mime:'application/pdf',filename:'assessor-deed-2010052603910.pdf',category:'deed',source_url:'https://county.test',provenance:'assessor_copy',record_key:'deed:20100526:03910'}]},'case1234',address)
  expect(parsed.originals[0].record_key).toBe('deed:20100526:03910')
  expect(uccTileLabel({category:'ucc',provenance:'recorder_record_summary'})).toBe('County record summary (not the filing)')
  expect(uccTileLabel({category:'ucc',provenance:'recorder_record_summary',amendment_only:true})).toBe(AMENDMENT_ONLY_LABEL)
  const amendment=validateRecordsResult({...result,parcel:result.parcel,outcomes:[{source:'clark',kind:'ucc',status:'recorder_record_summary'}],originals:[{url:'https://records.test/api/service/originals/hash',sha256:'c'.repeat(64),mime:'application/pdf',filename:'clark-recorder-summary-200807230001221.pdf',category:'ucc',source_url:'https://county.test',provenance:'recorder_record_summary',record_key:'ucc:200807230001221',amendment_only:true}]},'case1234',address)
  expect(amendment.originals[0].amendment_only).toBe(true)
  expect(()=>validateRecordsResult({...result,parcel:result.parcel,outcomes:[{source:'clark',kind:'deed',status:'assessor_copy'}],originals:[{url:'https://records.test/api/service/originals/hash',sha256:'b'.repeat(64),mime:'application/pdf',filename:'deed.pdf',category:'deed',source_url:'https://county.test',provenance:'assessor_copy',record_key:'lien:nope'}]},'case1234',address)).toThrow()
 })
 it('accepts a permit record-page screenshot only with a matching permit outcome',()=>{
  const file={url:'https://records.test/api/service/originals/hash',sha256:'a'.repeat(64),mime:'application/pdf',filename:'nlv-permit-BUILD-011787-2026-2026-09-30.pdf',category:'permit',source_url:'https://eg.cityofnorthlasvegas.com',provenance:'permit_record_page',record_key:'permit:nlv:BUILD-011787-2026'}
  const withParcel={...result,parcel:result.parcel,status:'complete'}
  const parsed=validateRecordsResult({...withParcel,outcomes:[{source:'north_las_vegas_energov',kind:'permit',status:'permit_record_page'}],originals:[file]},'case1234',address)
  expect(parsed.originals[0].provenance).toBe('permit_record_page')
  expect(permitTileLabel(parsed.originals[0])).toBe(PERMIT_RECORD_PAGE_LABEL)
  expect(permitTileLabel({category:'permit',provenance:'city_permit'})).toBeNull()
  expect(()=>validateRecordsResult({...withParcel,outcomes:[{source:'north_las_vegas_energov',kind:'permit',status:'original'}],originals:[file]},'case1234',address)).toThrow('no supported')
  expect(()=>validateRecordsResult({...withParcel,outcomes:[{source:'clark',kind:'permit',status:'no_permit_found',reason:'no_solar_permit'}],originals:[file]},'case1234',address)).toThrow('no supported')
 })
 it('carries a no permit found status and reason that staff can read',()=>{
  const none=(reason?:string)=>validateRecordsResult({...result,status:'complete',outcomes:[{source:'las_vegas_building',kind:'permit',status:'no_permit_found',...(reason?{reason}:{})}]},'case1234',address)
  expect(none('needs_human_check').outcomes[0].reason).toBe('needs_human_check')
  expect(permitStatusNote(none('needs_human_check'))).toBe('No permit found — needs human check')
  expect(permitStatusNote(none('outside_service_area'))).toBe('No permit found — outside service area')
  expect(permitStatusNote(none('no_solar_permit'))).toBe('No permit found — no solar permit on record')
  expect(permitStatusNote(none('login_required'))).toBe('No permit found — portal needs a login')
  expect(permitStatusNote(none())).toBe('No permit found — see records detail')
  expect(()=>none('made_up')).toThrow()
  expect(permitStatusNote({outcomes:[{kind:'permit',status:'unsupported'}]})).toBe('No permit found — outside service area')
  expect(permitStatusNote({outcomes:[{kind:'permit',status:'no_match'}]})).toBe('No permit found — no solar permit on record')
  expect(permitStatusNote({outcomes:[{kind:'permit',status:'original'}]})).toBeNull()
  expect(permitStatusNote({outcomes:[{kind:'permit',status:'permit_record_page'}]})).toBeNull()
  expect(permitStatusNote({outcomes:[{kind:'ucc',status:'failed'}]})).toBeNull()
  expect(permitStatusNote(null)).toBeNull()
 })
 it('shows the service headline and keeps the retry marker for the City of Las Vegas',()=>{
  const clv=validateRecordsResult({...result,status:'complete',outcomes:[{source:'las_vegas_building',kind:'permit',status:'no_permit_found',reason:'needs_human_check',retry_after:'2026-10-05T22:30:00Z',detail:'no permit found — City of Las Vegas site requires human verification: the permit record is only on www.lasvegasnevada.gov behind a Cloudflare check.'}]},'case1234',address)
  expect(clv.outcomes[0].retry_after).toBe('2026-10-05T22:30:00Z')
  expect(permitStatusNote(clv)).toBe('No permit found — City of Las Vegas site requires human verification')
  expect(()=>validateRecordsResult({...result,outcomes:[{source:'x',kind:'permit',status:'no_permit_found',retry_after:'tomorrow'}]},'case1234',address)).toThrow()
 })
})
