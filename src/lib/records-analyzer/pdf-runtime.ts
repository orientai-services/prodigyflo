import 'server-only';
import { definePDFJSModule, getDocumentProxy, extractText, renderPageAsImage } from 'unpdf';

let ready:Promise<void>|undefined;
/**
 * Upload page counting and rendering share one PDF.js API AND worker.
 * unpdf's bundled serverless worker is 6.x; switching only its API resolver to
 * installed pdfjs-dist 5.x leaves that worker on globalThis in warm functions.
 */
export function initializePdfRuntime():Promise<void> {
  ready ??= (async()=>{
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    // PDF.js ships no declaration for its worker entry point.
    // @ts-expect-error external runtime module exports WorkerMessageHandler
    const worker=await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    if(typeof worker.WorkerMessageHandler?.setup!=='function') throw Error('Matching PDF.js worker is unavailable');
    (globalThis as typeof globalThis & {pdfjsWorker:unknown}).pdfjsWorker={WorkerMessageHandler:worker.WorkerMessageHandler};
    await definePDFJSModule(async()=>pdfjs);
  })().catch(error=>{ready=undefined;throw error;});
  return ready;
}
export async function openPdfDocument(bytes:Uint8Array) {
  await initializePdfRuntime();
  return getDocumentProxy(bytes);
}
export async function extractPdfPages(pdf:Awaited<ReturnType<typeof openPdfDocument>>) {
  await initializePdfRuntime();
  return extractText(pdf,{mergePages:false});
}
export async function renderPdfPage(pdf:Awaited<ReturnType<typeof openPdfDocument>>,page:number) {
  await initializePdfRuntime();
  return renderPageAsImage(pdf,page,{canvasImport:()=>import('@napi-rs/canvas'),width:2576});
}
