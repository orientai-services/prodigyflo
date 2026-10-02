import {describe,it,expect} from 'vitest'
import {addressVersion,validateRecordsResult} from './contract'
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
})
