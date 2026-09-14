import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { db } from '@/lib/db'
import { POST } from '@/app/api/intake/[slug]/route'
import { hashIntakeSecret } from '@/lib/intake/hmac'
import { runPendingScsDocumentImports } from '@/lib/intake/scs-document-import'
import { getFileStorage } from '@/lib/storage'

const enabled = process.env.STAGE0_TESTS === '01a09fc2'
describe.skipIf(!enabled)('Stage 0 real SCS → ProdigyFlo handoff, isolated Postgres and files', () => {
  let server: Server, child: ChildProcess, scs: string, receiver: string, orgId: string, sourceId: string
  let mode = 'normal', lastPacket: any, releaseRequest: (()=>void)|undefined, requestArrived: (()=>void)|undefined
  const orgIds: string[] = []
  const nativeFetch = globalThis.fetch
  let fixture: any, payload: any, clientId: string
  const rpc = async (route:string, body:unknown={}) => {
    const r=await fetch(scs+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    return {status:r.status,body:await r.json()}
  }
  const send = (p=payload,eventId=randomUUID(),token='stage0-connector') => rpc('/send',{payload:p,leadId:fixture.leadId,eventId,token})
  beforeAll(async()=>{
    const u=new URL(process.env.DATABASE_URL!)
    if(u.hostname!=='127.0.0.1'||u.port!=='55482'||u.pathname!=='/pf_stage0_01a09fc2'||process.env.FILE_STORAGE_DRIVER!=='local') throw Error('Unsafe test destination')
    if(!process.env.FILE_STORAGE_LOCAL_DIR?.startsWith('/private/tmp/scs-pf-stage0-01a09fc2/'))throw Error('Unsafe test storage')
    globalThis.fetch = ((input:any,init?:any)=>{
      if(new URL(typeof input==='string'?input:input.url??input).hostname!=='127.0.0.1')throw Error('External network disabled in Stage 0')
      return nativeFetch(input,init)
    }) as typeof fetch
    const org=await db.organization.create({data:{name:'Synthetic Stage 0',slug:'stage0-'+randomUUID()}});orgId=org.id;orgIds.push(orgId)
    const pipeline=await db.pipeline.create({data:{organizationId:orgId,name:'Synthetic',isDefault:true}})
    await db.pipelineStage.create({data:{pipelineId:pipeline.id,key:'NEW_LEAD',name:'New',category:'INTAKE',position:0}})
    const source=await db.intakeSource.create({data:{organizationId:orgId,slug:'scs-website',name:'Synthetic SCS',kind:'WEB_FORM',authMode:'TOKEN',secretHash:hashIntakeSecret('stage0-connector'),fieldMapping:{firstName:'first_name',lastName:'last_name',email:'email',phone:'phone'},dedupeKeys:['email','phone']}});sourceId=source.id
    server=createServer(async(req,res)=>{
      try {
        const chunks=[];for await(const c of req)chunks.push(c)
        const raw=Buffer.concat(chunks).toString();lastPacket=JSON.parse(raw)
        if(mode==='outage'){res.writeHead(503);res.end();return}
        if(mode==='pause'){requestArrived?.();await new Promise<void>(r=>{releaseRequest=r})}
        const response=await POST(new Request(receiver+'/api/intake/scs-website',{method:'POST',body:raw,headers:req.headers as Record<string,string>}) as any,{params:Promise.resolve({slug:'scs-website'})})
        if(mode==='drop-after-receipt'){req.socket.destroy();return}
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text())
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:String(e)}))}
    })
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));receiver=`http://127.0.0.1:${(server.address() as any).port}`
    const cwd=process.env.SCS_STAGE0_WORKTREE!
    if(!cwd||!resolve(cwd).endsWith('/stage0/scs'))throw Error('Explicit isolated SCS worktree required')
    child=spawn(process.execPath,['--conditions=react-server','--import','tsx','scripts/stage0-server.ts'],{cwd,env:{PATH:process.env.PATH,STAGE0_TESTS:'01a09fc2',DATABASE_URL:'postgresql://stage0@127.0.0.1:55482/scs_stage0_01a09fc2',NODE_ENV:'test',UPLOAD_DIR:'/private/tmp/scs-pf-stage0-01a09fc2/scs-storage',PRODIGYFLO_INTAKE_URL:receiver+'/api/intake/scs-website',PRODIGYFLO_CONNECTOR_TOKEN:'stage0-connector',PRODIGYFLO_DOCUMENT_EXPORT_TOKEN:'stage0-export',RESUME_TOKEN_SECRET:'synthetic-resume',NEXT_PUBLIC_SITE_URL:'http://127.0.0.1',EXTRACTION_PROVIDER:'mock'},stdio:['ignore','pipe','pipe']})
    scs=await new Promise<string>((resolve,reject)=>{let text='';child.stdout!.on('data',b=>{text+=b;for(const line of text.split('\n')){try{const j=JSON.parse(line);if(j.port)resolve(`http://127.0.0.1:${j.port}`)}catch{}}});child.stderr!.on('data',b=>process.stderr.write(b));child.once('exit',code=>reject(Error('SCS harness exited '+code)))})
    process.env.SCS_DOCUMENT_EXPORT_BASE_URL=scs;process.env.SCS_DOCUMENT_EXPORT_TOKEN='stage0-export'
    fixture=(await rpc('/fixture')).body
    payload={lead_id:fixture.leadId,first_name:'Synthetic',last_name:'Homeowner',email:fixture.leadId+'@example.invalid',phone:'7025550101',portal_url:`http://127.0.0.1/p/${fixture.leadId}.synthetic`,data:{schema_version:'schema_42.v1',last_activity_at:'2026-01-01T00:00:00Z',stage1_answers:{first_name:'Synthetic',last_name:'Homeowner',email:fixture.leadId+'@example.invalid',phone:'7025550101',zip:'89101'},documents:{files:[{id:fixture.documentId,doc_type:'agreement',original_filename:'synthetic.pdf',mime:'application/pdf',size_bytes:fixture.size}]}}}
  })
  afterAll(async()=>{
    child?.kill('SIGTERM');if(server)await new Promise<void>(r=>server.close(()=>r()))
    globalThis.fetch=nativeFetch
    for(const id of orgIds)await db.organization.delete({where:{id}})
  })
  it('rejects wrong authentication without creating an intake',async()=>{
    expect((await send(payload,randomUUID(),'wrong')).status).toBe(500)
    expect(await db.intakeSubmission.count({where:{sourceId}})).toBe(0)
  })
  it('actual sender transmits stable case ID and receiver queues documents before copying',async()=>{
    const r=await send();expect(r.status).toBe(200);clientId=r.body.remoteId;expect(clientId).toBeTruthy()
    expect(lastPacket.lead_id).toBe(fixture.leadId)
    const row=await db.intakeSubmission.findUniqueOrThrow({where:{sourceId_externalId:{sourceId,externalId:'scs:'+fixture.leadId}}})
    expect(row.clientId).toBe(clientId);expect(await db.clientDocument.count({where:{clientId}})).toBe(0)
    expect(await db.externalDocumentImport.count({where:{clientId,status:'PENDING'}})).toBe(1)
  })
  it('TOKEN and HMAC modes agree on the same sender token',async()=>{
    await db.intakeSource.update({where:{id:sourceId},data:{authMode:'HMAC'}})
    expect((await send()).status).toBe(200)
    await db.intakeSource.update({where:{id:sourceId},data:{authMode:'TOKEN'}})
  })
  it('exports files with old and dedicated credentials, rejects unrelated credentials',async()=>{
    for(const [token,status] of [['stage0-connector',200],['stage0-export',200],['wrong',401]] as const){
      const r=await fetch(`${scs}/api/internal/prodigyflo/documents/${fixture.documentId}`,{headers:{'X-SCS-Export-Token':token}})
      expect(r.status).toBe(status)
    }
  })
  it('same case survives changed contact details, concurrent replay and reversed arrival order',async()=>{
    const role=await db.role.create({data:{organizationId:orgId,key:'CLOSER',name:'Synthetic owner'}})
    const owner=await db.user.create({data:{organizationId:orgId,roleId:role.id,name:'Synthetic Owner',email:randomUUID()+'@example.invalid',passwordHash:'not-a-login'}})
    await db.client.update({where:{id:clientId},data:{ownerId:owner.id}})
    const newer={...payload,email:'changed@example.invalid',data:{...payload.data,last_activity_at:'2026-01-02T00:00:00Z',stage1_answers:{...payload.data.stage1_answers,installer_guess:'New value'}}}
    const id=randomUUID();const replies=await Promise.all([send(newer,id),send(newer,id),send(payload)])
    expect(replies.every(r=>r.status===200)).toBe(true)
    expect(new Set(replies.map(r=>r.body.remoteId))).toEqual(new Set([clientId]))
    expect(await db.client.count({where:{organizationId:orgId}})).toBe(1)
    expect((await db.client.findUniqueOrThrow({where:{id:clientId}})).ownerId).toBe(owner.id)
    const receipt=await db.intakeSubmission.findFirstOrThrow({where:{sourceId}})
    expect((receipt.rawPayload as any).data.stage1_answers.installer_guess).toBe('New value')
  })
  it('survives a lost acknowledgment without duplicating the case',async()=>{
    const update={...payload,data:{...payload.data,last_activity_at:'2026-01-03T00:00:00Z'}}
    const event=randomUUID()
    mode='drop-after-receipt';expect((await send(update,event)).status).toBe(500);mode='normal'
    expect((await send(update,event)).body.remoteId).toBe(clientId)
    expect(((await db.intakeSubmission.findFirstOrThrow({where:{sourceId}})).rawPayload as any).data.last_activity_at).toBe('2026-01-03T00:00:00Z')
    expect(await db.client.count({where:{organizationId:orgId}})).toBe(1)
  })
  it('pauses import work without losing queued receipt metadata',async()=>{
    const before=await db.externalDocumentImport.findMany({where:{clientId},orderBy:{id:'asc'}})
    process.env.SCS_DOCUMENT_IMPORTS_PAUSED='true'
    try {
      expect((await runPendingScsDocumentImports()).attempted).toBe(0)
      expect(await db.externalDocumentImport.findMany({where:{clientId},orderBy:{id:'asc'}})).toEqual(before)
    } finally {delete process.env.SCS_DOCUMENT_IMPORTS_PAUSED}
  })
  it('pauses SCS dispatch while preserving collection and enqueue',async()=>{
    await rpc('/pause',{paused:true})
    try {
      const f=(await rpc('/fixture')).body
      await rpc('/enqueue',{leadId:f.leadId})
      const before=(await rpc('/delivery',{leadId:f.leadId})).body
      expect((await rpc('/dispatch')).body.sent).toBe(0)
      expect((await rpc('/delivery',{leadId:f.leadId})).body).toEqual(before)
      expect(before[0].status).toBe('pending')
    } finally {await rpc('/pause',{paused:false})}
  })
  it('imports bytes once using real SCS export and private local ProdigyFlo storage',async()=>{
    await runPendingScsDocumentImports()
    const doc=await db.clientDocument.findFirstOrThrow({where:{clientId}})
    expect((await getFileStorage().get(doc.storageKey!)).toString()).toContain('Synthetic Stage 0')
    await Promise.all([runPendingScsDocumentImports(),runPendingScsDocumentImports()])
    expect(await db.clientDocument.count({where:{clientId}})).toBe(1)
  })
  it('recovers an abandoned import and leaves exhausted rows untouched',async()=>{
    const f=(await rpc('/fixture')).body
    const submission=await db.intakeSubmission.findFirstOrThrow({where:{sourceId}})
    const abandoned=await db.externalDocumentImport.create({data:{organizationId:orgId,intakeSubmissionId:submission.id,clientId,sourceDocumentId:f.documentId,sourceLeadId:f.leadId,sourceMimeType:'application/pdf',status:'IMPORTING',attempts:1,updatedAt:new Date(0)}})
    const exhausted=await db.externalDocumentImport.create({data:{organizationId:orgId,intakeSubmissionId:submission.id,clientId,sourceDocumentId:randomUUID(),status:'FAILED',attempts:8}})
    await runPendingScsDocumentImports()
    expect((await db.externalDocumentImport.findUniqueOrThrow({where:{id:abandoned.id}})).status).toBe('IMPORTED')
    expect((await db.externalDocumentImport.findUniqueOrThrow({where:{id:exhausted.id}})).attempts).toBe(8)
  })
  it('rejects a source document whose case header mismatches',async()=>{
    const f=(await rpc('/fixture')).body;const submission=await db.intakeSubmission.findFirstOrThrow({where:{sourceId}})
    const row=await db.externalDocumentImport.create({data:{organizationId:orgId,intakeSubmissionId:submission.id,clientId,sourceDocumentId:f.documentId,sourceLeadId:randomUUID(),status:'PENDING'}})
    await runPendingScsDocumentImports()
    const failed=await db.externalDocumentImport.findUniqueOrThrow({where:{id:row.id}})
    expect(failed.status).toBe('FAILED');expect(failed.lastError).toContain('case identity')
  })
  it('SCS queue survives outage, limits concurrent claims and preserves refreshed revisions',async()=>{
    const f=(await rpc('/fixture')).body
    await rpc('/enqueue',{leadId:f.leadId});mode='outage'
    expect((await rpc('/dispatch')).body.failed).toBeGreaterThan(0)
    expect((await rpc('/delivery',{leadId:f.leadId})).body[0].status).toBe('failed')
    mode='pause';await rpc('/due',{leadId:f.leadId})
    const arrived=new Promise<void>(r=>{requestArrived=r});const dispatch=rpc('/dispatch');await arrived
    expect((await rpc('/dispatch')).body.sent).toBe(0)
    await rpc('/enqueue',{leadId:f.leadId});releaseRequest!();await dispatch
    const row=(await rpc('/delivery',{leadId:f.leadId})).body[0];expect(row.status).toBe('pending');expect(row.revision).toBe(1)
    mode='normal';await rpc('/dispatch')
    expect((await rpc('/delivery',{leadId:f.leadId})).body[0].status).toBe('sent')
  })
  it('serializes concurrent first receipts and upgrades an exact legacy receipt without a new case',async()=>{
    const f=(await rpc('/fixture')).body
    const fresh={...payload,email:f.leadId+'@example.invalid',phone:f.leadId.replaceAll('-',''),portal_url:`http://127.0.0.1/p/${f.leadId}.synthetic`,data:{...payload.data,documents:{files:[]},stage1_answers:{}}}
    const direct={...fresh,id:randomUUID()};delete (direct as any).lead_id
    const oldResponse=await fetch(receiver+'/api/intake/scs-website',{method:'POST',headers:{'X-Connector-Token':'stage0-connector'},body:JSON.stringify(direct)})
    const old=await oldResponse.json();expect(oldResponse.status).toBe(200)
    const prior=await db.intakeSubmission.findUniqueOrThrow({where:{id:old.submissionId}})
    const replies=await Promise.all([1,2,3].map(()=>rpc('/send',{payload:fresh,leadId:f.leadId,eventId:randomUUID()})))
    expect(replies.every(r=>r.status===200&&r.body.remoteId===old.clientId)).toBe(true)
    const receipt=await db.intakeSubmission.findUniqueOrThrow({where:{sourceId_externalId:{sourceId,externalId:'scs:'+f.leadId}}})
    expect(receipt.id).toBe(prior.id);expect(receipt.createdAt).toEqual(prior.createdAt)
    const g=(await rpc('/fixture')).body
    const unique={...fresh,email:g.leadId+'@example.invalid',phone:g.leadId.replaceAll('-',''),portal_url:`http://127.0.0.1/p/${g.leadId}.synthetic`}
    const first=await Promise.all([1,2,3].map(()=>rpc('/send',{payload:unique,leadId:g.leadId,eventId:randomUUID()})))
    expect(first.every(r=>r.status===200)).toBe(true)
    expect(new Set(first.map(r=>r.body.remoteId)).size).toBe(1)
  })
  it('holds a different source case with matching contact details for reconciliation',async()=>{
    const id=randomUUID();const before=await db.client.count({where:{organizationId:orgId}})
    const r=await rpc('/send',{payload:{...payload,portal_url:`http://127.0.0.1/p/${id}.synthetic`},leadId:id,eventId:randomUUID()})
    expect(r.status).toBe(500)
    expect((await db.intakeSubmission.findUniqueOrThrow({where:{sourceId_externalId:{sourceId,externalId:'scs:'+id}}})).status).toBe('NEEDS_MAPPING')
    expect(await db.client.count({where:{organizationId:orgId}})).toBe(before)
  })
  it('fences a superseded document worker and removes only its uncommitted file',async()=>{
    const f=(await rpc('/fixture')).body;const submission=await db.intakeSubmission.findFirstOrThrow({where:{sourceId}})
    const row=await db.externalDocumentImport.create({data:{organizationId:orgId,intakeSubmissionId:submission.id,clientId,sourceDocumentId:f.documentId,sourceLeadId:f.leadId,status:'PENDING'}})
    const storage=getFileStorage(),put=storage.put.bind(storage);let uncommitted=''
    const spy=vi.spyOn(storage,'put').mockImplementationOnce(async(bytes,meta)=>{
      const saved=await put(bytes,meta);uncommitted=saved.key
      await db.externalDocumentImport.update({where:{id:row.id},data:{status:'FAILED',attempts:2}})
      return saved
    })
    try{
      await runPendingScsDocumentImports(1)
      expect((await db.externalDocumentImport.findUniqueOrThrow({where:{id:row.id}})).clientDocumentId).toBeNull()
      expect(uncommitted).not.toBe('');expect(await storage.stat(uncommitted)).toBeNull()
    }finally{spy.mockRestore()}
  })
  it('blocks accidental external provider calls in the harness',async()=>{
    expect(()=>fetch('https://example.com')).toThrow('External network disabled')
  })

  it('rejects credentials shared across tenants instead of selecting an arbitrary receiver',async()=>{
    const org=await db.organization.create({data:{name:'Synthetic other tenant',slug:'stage0-other-'+randomUUID()}});orgIds.push(org.id)
    const other=await db.intakeSource.create({data:{organizationId:org.id,name:'Synthetic other source',slug:'scs-website',kind:'WEB_FORM',authMode:'TOKEN',secretHash:hashIntakeSecret('stage0-connector')}})
    const before=await db.intakeSubmission.count({where:{organizationId:org.id}})
    expect((await send()).status).toBe(500)
    expect(await db.intakeSubmission.count({where:{organizationId:org.id}})).toBe(before)
    await db.intakeSource.update({where:{id:other.id},data:{isEnabled:false}})
    expect((await send()).status).toBe(200)
  })
  it('holds conflicting exact historical case links without merging clients',async()=>{
    const f=(await rpc('/fixture')).body
    const prior=await db.client.findUniqueOrThrow({where:{id:clientId}})
    const other=await db.client.create({data:{organizationId:orgId,pipelineId:prior.pipelineId,currentStageId:prior.currentStageId,firstName:'Synthetic',lastName:'Conflict',email:'conflict@example.invalid',phone:'0000000011'}})
    const portal=`http://127.0.0.1/p/${f.leadId}.synthetic`
    for(const id of [clientId,other.id])await db.intakeSubmission.create({data:{organizationId:orgId,sourceId,externalId:randomUUID(),clientId:id,status:'APPLIED',rawPayload:{portal_url:portal}}})
    const before=await db.client.count({where:{organizationId:orgId}})
    expect((await rpc('/send',{payload:{...payload,portal_url:portal},leadId:f.leadId,eventId:randomUUID()})).status).toBe(500)
    expect(await db.client.count({where:{organizationId:orgId}})).toBe(before)
    expect(await db.intakeSubmission.count({where:{sourceId,externalId:'scs:'+f.leadId}})).toBe(0)
  })

})
