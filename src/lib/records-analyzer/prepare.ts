// Synchronized from SCS Records adapter, 2026-09-20.
import 'server-only';
import { createHash } from 'node:crypto';
import { openPdfDocument,renderPdfPage } from './pdf-runtime';
import sharp from 'sharp';
import { pageHasText } from './text-layer';

export interface PreparedPage { page: number; text: string | null; imageKey: string; width: number; height: number }
export interface PreparedDocument { id: string; name: string; sha256: string; pages: PreparedPage[]; totalPages?:number; complete?:boolean }
export async function prepareDocumentChunk(doc: {id:string;name:string;mime:string;bytes:Buffer}, save: (key:string,bytes:Buffer)=>Promise<void>, previous?:PreparedDocument, maxPages=3): Promise<PreparedDocument> {
  const hash=createHash('sha256').update(doc.bytes).digest('hex');
  if(previous && (previous.sha256!==hash || previous.id!==doc.id)) throw Error('Preparation checkpoint does not match original bytes');
  const pages: PreparedPage[]=[...(previous?.pages??[])]; let totalPages=0;
  async function page(number:number,raw:Buffer,text:string|null) {
    const result=await sharp(raw).rotate().resize({width:2576,height:2576,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:92}).toBuffer({resolveWithObject:true});
    const imageKey=`${doc.id}/${hash}/p${number}.jpg`;
    await save(imageKey,result.data);
    pages.push({page:number,text:text && !text.includes('\0') && pageHasText(text) ? text : null,imageKey,width:result.info.width,height:result.info.height});
  }
  if(doc.mime==='application/pdf') {
    const pdf=await openPdfDocument(new Uint8Array(doc.bytes));
    try {
      totalPages=pdf.numPages;
      if(!totalPages) throw Error('PDF page accounting failed');
      const through=Math.min(totalPages,pages.length+maxPages);
      for(let i=pages.length+1;i<=through;i++) {
        const textPage=await pdf.getPage(i);
        const text=(await textPage.getTextContent()).items.map(item=>'str' in item?item.str:'').join(' ');
        textPage.cleanup();
        const raw=await renderPdfPage(pdf,i);
        if(typeof raw==='string') throw Error('Unexpected PDF rendering output');
        await page(i,Buffer.from(raw),text);
      }
    } finally { await pdf.loadingTask.destroy(); }
  } else if(/^image\/(jpeg|png|webp|tiff|heic|heif)$/.test(doc.mime)) {
    const metadata=await sharp(doc.bytes).metadata();
    // Multi-page images cannot be silently reduced to their first page.
    totalPages=metadata.pages??1;
    const through=Math.min(totalPages,pages.length+maxPages);
    for(let i=pages.length;i<through;i++) await page(i+1,await sharp(doc.bytes,{page:i,pages:1}).png().toBuffer(),null);
  } else throw Error(`Unsupported document format: ${doc.mime}. Replace or explicitly remove this file.`);
  return {id:doc.id,name:doc.name,sha256:hash,pages,totalPages,complete:pages.length===totalPages};
}
export async function prepareDocument(doc: {id:string;name:string;mime:string;bytes:Buffer}, save: (key:string,bytes:Buffer)=>Promise<void>):Promise<PreparedDocument> {
  let prepared:PreparedDocument|undefined;
  do { prepared=await prepareDocumentChunk(doc,save,prepared); } while(!prepared.complete);
  return prepared;
}
export interface BatchFile {name:string;kind:'text_pdf'|'scan_pdf';pages:number;dims:number[][];documentId:string;originalName:string;originalSha256?:string;pageOffset:number;prepared:PreparedPage[]}
/** Split by physical pages and per-page text quality. Never drop a file or page. */
export function makeBatches(documents: PreparedDocument[]): BatchFile[][] {
  const batches:BatchFile[][]=[]; let batch:BatchFile[]=[]; let count=0;
  function flush() { if(batch.length) batches.push(batch); batch=[];count=0; }
  for(const doc of documents) {
    let offset=0;
    while(offset<doc.pages.length) {
      if(batch.length===20 || count===60) flush();
      const kind=doc.pages[offset].text===null ? 'scan_pdf' : 'text_pdf';
      let end=offset;
      while(end<doc.pages.length && end-offset<60-count && (doc.pages[end].text===null?'scan_pdf':'text_pdf')===kind) end++;
      const prepared=doc.pages.slice(offset,end);
      batch.push({name:`${doc.id}_p${offset+1}-${end}.pdf`,kind,pages:prepared.length,dims:prepared.map(p=>[p.width,p.height]),documentId:doc.id,originalName:doc.name,originalSha256:doc.sha256,pageOffset:offset,prepared});
      count+=prepared.length;offset=end;
    }
  }
  flush();return batches;
}
