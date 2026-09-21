import {describe,it,expect} from 'vitest'
import {getDocumentProxy} from 'unpdf'
import {makeTextPdf} from '../../../tests/fixtures/pdf'
import {extractPdfText} from '@/lib/extraction/pdf-text'
import {prepareDocumentChunk,type PreparedDocument} from './prepare'

describe('matching server PDF API and worker after legacy text extraction',()=>{
 it('prepares all physical pages in resumable chunks after unpdf initializes its default worker',async()=>{
  const bytes=makeTextPdf(Array.from({length:9},(_,i)=>i===4?'':`Synthetic agreement page ${i+1}. This is test-only evidence for PDF preparation and contains no real client information.`))
  const legacy=await getDocumentProxy(new Uint8Array(bytes))
  expect(legacy.numPages).toBe(9)
  await legacy.loadingTask.destroy()
  expect((await extractPdfText(bytes)).pageCount).toBe(9)
  let prepared:PreparedDocument|undefined
  const saved:string[]=[]
  for(let chunk=0;chunk<3;chunk++) {
   prepared=await prepareDocumentChunk({id:'synthetic-pdf',name:'synthetic.pdf',mime:'application/pdf',bytes},async(key,image)=>{saved.push(key);expect(image.length).toBeGreaterThan(0)},prepared,3)
   expect(prepared.pages).toHaveLength((chunk+1)*3)
   expect(prepared.totalPages).toBe(9)
  }
  expect(prepared?.complete).toBe(true)
  expect(prepared?.pages.map(p=>p.page)).toEqual([1,2,3,4,5,6,7,8,9])
  expect(prepared?.pages[4].text).toBeNull()
  expect(new Set(saved).size).toBe(9)
 })
})
