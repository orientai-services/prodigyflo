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
})
