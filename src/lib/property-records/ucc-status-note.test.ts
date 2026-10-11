import {describe,it,expect} from 'vitest'
import {uccStatusNote} from './contract'

const done=(ucc?:{status?:string;detail?:string},files:{category:string}[]=[])=>({status:'partial',files,outcomes:[{source:'clark_assessor',kind:'deed',status:'assessor_copy'},...(ucc?[{source:'clark_recorder',kind:'ucc',...ucc}]:[])]})

describe('uccStatusNote',()=>{
 it('says no UCC on file when the index search found none',()=>{
  expect(uccStatusNote(done({status:'no_match',detail:'No UCC on file — 12 index entries checked'}))).toBe('No UCC on file — county index searched')
  expect(uccStatusNote(done())).toBe('No UCC on file — county index searched')
  expect(uccStatusNote(done({status:'failed',detail:'No UCC record page was captured'}))).toBe('No UCC on file — county index searched')
 })
 it('says the lookup failed, with the reason, for real errors',()=>{
  expect(uccStatusNote(done({status:'failed',detail:'search_timeout: the Clark recorder search posted but returned no rows in time.'}))).toBe('UCC lookup failed — search_timeout: the Clark recorder search posted but returned no rows in time.')
  expect(uccStatusNote(done({status:'failed',detail:'Needs human check: cloudflare_challenge'}))).toBe('UCC lookup failed — Needs human check: cloudflare_challenge')
  expect(uccStatusNote(done({status:'failed'}))).toBe('UCC lookup failed — see records detail')
 })
 it('stays out of the way when a UCC page was filed or nothing applies',()=>{
  expect(uccStatusNote(done({status:'recorder_record_summary'},[{category:'ucc'}]))).toBeNull()
  expect(uccStatusNote(done({status:'unsupported'}))).toBeNull()
  expect(uccStatusNote(null)).toBeNull()
  expect(uccStatusNote({})).toBeNull()
 })
})
