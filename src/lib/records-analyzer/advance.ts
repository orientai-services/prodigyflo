// Synchronized from SCS Records adapter, 2026-09-20.
import 'server-only';
import { analyzerClient } from './client';
import type { BatchFile } from './prepare';
export interface BatchState {id:string;runId:string|null;uploaded:boolean;files:BatchFile[];uploadCheckpoint?:string[]}
export interface BatchCheckpoint {runId?:string;uploaded?:boolean;uploadCheckpoint?:string[];pageProgress?:Record<string,number>}
/** Bounded image upload and model stage checkpoints survive every process boundary. */
export async function advanceBatch(caseId:string,batch:BatchState,identity:Record<string,unknown>,
  readImage:(key:string)=>Promise<Buffer>,checkpoint:(patch:BatchCheckpoint)=>Promise<void>) {
  const api=analyzerClient(caseId);
  let runId=batch.runId;
  if(!runId) {
    const created=await api('/runs',{method:'POST',requestId:`batch:${batch.id}`,body:{label:caseId,identity,files:batch.files.map(f=>({name:f.name,kind:f.kind,pages:f.pages,dims:f.dims,original_id:f.documentId,original_sha256:f.originalSha256,page_offset:f.pageOffset}))}});
    runId=created.id; await checkpoint({runId:runId!});
  }
  if(!batch.uploaded) {
    const uploaded=new Set(batch.uploadCheckpoint??[]);let sent=0;
    for(const [i,file] of batch.files.entries()) {
      for(const [p,page] of file.prepared.entries()) {
        const key=`f${i}p${p+1}.jpg`; if(uploaded.has(key)) continue;
        await api(`/runs/${runId}/blob/${key}`,{method:'PUT',bytes:await readImage(page.imageKey)});
        uploaded.add(key);await checkpoint({uploadCheckpoint:[...uploaded]});
        if(++sent>=4) return {done:false as const};
      }
      const key=`text:${i}`;
      if(file.kind==='text_pdf' && !uploaded.has(key)) {
        await api(`/runs/${runId}/textlayer`,{method:'POST',body:{file:i,pages:file.prepared.map(p=>p.text)}});
        uploaded.add(key);await checkpoint({uploadCheckpoint:[...uploaded]});
      }
    }
    await checkpoint({uploaded:true});
  }
  const snapshot=await api(`/runs/${runId}`);
  const progress:Record<string,number>={};
  for(const [i,file] of batch.files.entries()) {
    let pages=file.kind==='text_pdf'?file.pages:0;
    if(file.kind==='scan_pdf') for(let from=1;from<=file.pages;from+=3) if(snapshot.stages?.[`transcribe:${i}:${from}`]?.status==='done') pages+=Math.min(3,file.pages-from+1);
    progress[file.documentId]=(progress[file.documentId]??0)+pages;
  }
  await checkpoint({pageProgress:progress});
  if(snapshot.case) return {done:true as const,result:snapshot.case};
  for(const [i,file] of batch.files.entries()) {
    if(file.kind==='text_pdf') continue;
    for(let from=1;from<=file.pages;from+=3) {
      if(snapshot.stages?.[`transcribe:${i}:${from}`]?.status==='done') continue;
      await api(`/runs/${runId}/stage/transcribe?file=${i}&from=${from}&to=${Math.min(file.pages,from+2)}`,{method:'POST'});
      progress[file.documentId]=(progress[file.documentId]??0)+Math.min(3,file.pages-from+1);
      await checkpoint({pageProgress:progress});return {done:false as const};
    }
  }
  for(const stage of ['extract','reconcile','verify','finalize']) {
    if(snapshot.stages?.[stage]?.status==='done') continue;
    const output=await api(`/runs/${runId}/stage/${stage}`,{method:'POST'});
    return stage==='finalize' ? {done:true as const,result:output.output} : {done:false as const};
  }
  throw Error('Analyzer stage state is inconsistent');
}
