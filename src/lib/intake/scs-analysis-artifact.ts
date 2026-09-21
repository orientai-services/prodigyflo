import 'server-only'
import {createHash} from 'node:crypto'
import {asRecord,str} from '@/lib/packet/schema'
import {analysisMetadata} from './analysis-contract'

/** Resolve before opening a DB transaction. Credentials never follow redirects. */
export async function resolveScsAnalysisArtifact(rawPayload:unknown):Promise<unknown> {
  const raw=asRecord(rawPayload),data=asRecord(raw.data),analysis=asRecord(data.analysis),artifact=asRecord(analysis.artifact)
  if(!analysis.artifact) return rawPayload
  const metadata=analysisMetadata.parse(analysis)
  const base=new URL(process.env.SCS_DOCUMENT_EXPORT_BASE_URL??'https://not-configured.invalid')
  const url=new URL(str(artifact.url))
  if(base.hostname==='not-configured.invalid'||!process.env.SCS_DOCUMENT_EXPORT_TOKEN) throw Error('SCS analysis export is not configured')
  if(base.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(base.hostname))) throw Error('SCS export requires HTTPS')
  if(url.origin!==base.origin||url.username||url.password||url.pathname!==`/api/internal/prodigyflo/analysis/${metadata.manifestId}`||url.searchParams.get('sha256')!==artifact.sha256) throw Error('Untrusted SCS analysis artifact URL')
  const bytes=Number(artifact.bytes),max=25*1024*1024
  if(!Number.isSafeInteger(bytes)||bytes<2||bytes>max||!/^[a-f0-9]{64}$/.test(str(artifact.sha256))) throw Error('Invalid analysis artifact size/checksum')
  const response=await fetch(url,{headers:{'X-SCS-Export-Token':process.env.SCS_DOCUMENT_EXPORT_TOKEN,...(process.env.SCS_VERCEL_PROTECTION_BYPASS?{'x-vercel-protection-bypass':process.env.SCS_VERCEL_PROTECTION_BYPASS}:{})},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(55_000)})
  if(!response.ok||!response.body) throw Error(`SCS analysis export failed (${response.status})`)
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0
  try {while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>bytes)throw Error('Analysis artifact exceeded declared size');chunks.push(part.value)}}finally{await reader.cancel()}
  const content=Buffer.concat(chunks)
  if(total!==bytes||createHash('sha256').update(content).digest('hex')!==artifact.sha256) throw Error('Analysis artifact checksum mismatch')
  const full=JSON.parse(content.toString('utf8'))
  if(JSON.stringify(analysisMetadata.parse(full))!==JSON.stringify(metadata)) throw Error('Analysis artifact metadata mismatch')
  return {...raw,data:{...data,analysis:full}}
}
