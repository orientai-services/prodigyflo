import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { syncAssignedSunoffLeads } from './assigned'
import { sunoffLeadId } from './assigned-model'
import { writeAssignedCalendar } from './assigned-calendar-write'
import { listOpenSlots } from '@/lib/call-center/calendar/service'
import { writeAssignedLead, ASSIGNED_COMMAND_PATH } from './assigned-write'
import { verifyBridgeRequest } from './sign'
import { scsIntakeLinkFor } from '@/lib/call-center/desk'
import { POST as prefill } from '@/app/api/intake/scs/prefill/route'
import { verifyIntakeToken } from '@/lib/call-center/intake-link'
import type { SessionUser } from '@/lib/rbac'

const NOW=Date.now(), stamp=`source-write-${NOW}`, KEY='synthetic-two-way-key-01234567890123456789'
const source={ id:'meta_9000100020003',brand:'sunoff',userId:'63',name:'Sample Homeowner',phone:'+17025550123',email:'sample@example.test',
  address:'123 Example St, Las Vegas, NV 89117',language:'EN',createdAt:NOW-10000,updatedAt:NOW-1000,
  appointmentAt:NOW+864e5,followupAt:null,stage:'Scheduled',closed:false,doNotCall:false,consent:null }
describe('ProdigyFlo saves source changes and opens a single scoped SCS intake',()=>{
  let org='',other='',gatsby='',dakota='',owner='',id=''
  let people: {id:string;email:string;organizationId:string}[]=[]
  const actor=()=>({id:owner,name:'Owner',role:'SUPER_ADMIN'})
  async function sync(revision:number,lead=source){
    vi.spyOn(db.user,'findMany').mockResolvedValueOnce(people as never)
    return syncAssignedSunoffLeads({version:1,complete:true,revision,leads:[lead]})
  }
  beforeAll(async()=>{
    if(!['localhost','127.0.0.1','::1'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error('Local test DB required')
    org=(await db.organization.create({data:{name:stamp,slug:stamp}})).id
    other=(await db.organization.create({data:{name:stamp+'-other',slug:stamp+'-other'}})).id
    const role=await db.role.create({data:{organizationId:org,key:'SUPER_ADMIN',name:'Admin'}})
    for(const name of ['Gatsby','Dakota','Owner']) {
      const u=await db.user.create({data:{organizationId:org,roleId:role.id,name,email:`${name}-${stamp}@example.test`,passwordHash:'unused'}})
      if(name==='Gatsby')gatsby=u.id; else if(name==='Dakota')dakota=u.id; else owner=u.id
    }
    people=[{id:gatsby,email:'itsgatsby@protonmail.com',organizationId:org},{id:dakota,email:'dakota.hanshew@gmail.com',organizationId:org}]
    id=sunoffLeadId(org,source.id)
    vi.stubEnv('PF_SUNOFF_BRIDGE_KEY',KEY); vi.stubEnv('AUTH_SECRET','synthetic-intake-link-only-0123456789')
    await sync(NOW)
  })
  afterEach(()=>{vi.restoreAllMocks()})
  afterAll(async()=>{vi.unstubAllEnvs(); for(const id of [org,other])if(id)await db.organization.delete({where:{id}})})
  it('opens for the owner without stealing Gatsby’s assignment and returns known facts for this token only',async()=>{
    const user={...actor(),organizationId:org} as SessionUser
    const link=await scsIntakeLinkFor(user,id,'open')
    expect(link.ok).toBe(true)
    if(!link.ok || !('url' in link) || !link.url)throw Error('Expected intake URL')
    const url=new URL(link.url)
    expect(url.origin).toBe('https://solarcontractservices.com');expect(url.pathname).toBe('/begin')
    expect(url.searchParams.get('fresh')).toBe('1');expect(link.url).not.toContain('7025550123')
    const token=url.searchParams.get('pfl')!
    expect(verifyIntakeToken(token)).toMatchObject({ok:true,leadId:id})
    const r=await prefill(new Request('https://www.prodigyflo.ai/api/intake/scs/prefill',{method:'POST',body:JSON.stringify({token})}))
    expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store')
    expect(await r.json()).toMatchObject({ok:true,values:{full_name:'Sample Homeowner',phone:'+17025550123',email:'sample@example.test',address_line1:'123 Example St',city:'Las Vegas',state:'NV',zip:'89117'}})
    expect((await db.callCenterLead.findUniqueOrThrow({where:{id}})).lockedBy).toBe(gatsby)
    expect((await scsIntakeLinkFor({...user,organizationId:other},id,'open')).ok).toBe(false)
    const bad=await prefill(new Request('https://www.prodigyflo.ai/api/intake/scs/prefill',{method:'POST',body:JSON.stringify({token:token.slice(0,-1)+'!'})}))
    expect(bad.status).toBe(401)
  })
  it('retries exactly the same signed command on a lost response and mirrors the accepted result',async()=>{
    const sent:string[]=[]
    const next={...source,appointmentAt:NOW+2*864e5,updatedAt:NOW+1}
    vi.spyOn(db.user,'findMany').mockResolvedValueOnce(people as never)
    const send=vi.fn(async(url: string | URL | Request,init?:RequestInit)=>{
      expect(String(url)).toBe('https://dialer.sunoff.app'+ASSIGNED_COMMAND_PATH)
      const body=String(init!.body),h=new Headers(init!.headers); sent.push(body)
      expect(h.get('user-agent')).toBe('SunOff-ProdigyFlo-Bridge/1.0')
      expect(verifyBridgeRequest({key:KEY,method:'POST',path:ASSIGNED_COMMAND_PATH,body,ts:h.get('x-pf-bridge-ts'),sig:h.get('x-pf-bridge-sig')})).toMatchObject({ok:true})
      if(sent.length===1)throw Error('simulated lost response')
      return Response.json({ok:true,snapshot:{version:1,complete:true,revision:NOW+2,leads:[next]}})
    }) as typeof fetch
    expect(await writeAssignedLead(org,actor(),id,{type:'booking',at:next.appointmentAt},{fetchImpl:send})).toEqual({ok:true})
    expect(sent).toHaveLength(2);expect(sent[0]).toBe(sent[1])
    expect(JSON.parse(sent[0])).toMatchObject({leadId:source.id,expected:source.updatedAt,actor:{uid:'owner'}})
    expect((await db.callCenterSlot.findFirstOrThrow({where:{leadId:id}})).startsAt.getTime()).toBe(next.appointmentAt)
    await sync(NOW+3,next)
    expect(await db.callCenterSlot.count({where:{leadId:id}})).toBe(1)
  })
  it('books, confirms and records an outcome on the same source slot through the calendar handler',async()=>{
    const user={...actor(),organizationId:org} as SessionUser
    const times=await listOpenSlots(org)
    const time=times.find(t=>t.repKey==='gatsby')!
    expect(time).toBeTruthy()
    const slotId=`sunoff:${org}:${source.id}:visit`
    const next={...source,appointmentAt:time.startsAt.getTime(),updatedAt:NOW+4,visitStatus:'HOLD'}
    let revision=NOW+5
    vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      const b=JSON.parse(String(init?.body))
      if(b.change.type==='confirm')next.visitStatus='CONFIRMED'
      if(b.change.type==='visit'){next.appointmentAt=null as unknown as number;next.visitStatus='NO_SHOW'}
      next.updatedAt=revision
      vi.spyOn(db.user,'findMany').mockResolvedValueOnce(people as never)
      return Response.json({ok:true,snapshot:{version:1,complete:true,revision:revision++,leads:[next]}})
    })
    expect(await writeAssignedCalendar(user,{slotId},{type:'booking',at:time.startsAt.getTime()},'gatsby')).toMatchObject({ok:true,slotId})
    expect(await writeAssignedCalendar(user,{slotId},{type:'confirm'})).toMatchObject({ok:true})
    expect((await db.callCenterSlot.findUniqueOrThrow({where:{id:slotId}})).status).toBe('CONFIRMED')
    expect(await writeAssignedCalendar(user,{slotId},{type:'visit',outcome:'no-show'})).toMatchObject({ok:true})
    expect((await db.callCenterSlot.findUniqueOrThrow({where:{id:slotId}})).status).toBe('NO_SHOW')
    expect(await db.callCenterSlot.count({where:{leadId:id}})).toBe(1)
  })
  it('uses Gatsby’s existing identity without a role upgrade and denies a different rep',async()=>{
    const send=vi.fn(async(_url,init)=>{
      expect(JSON.parse(String(init?.body))).toMatchObject({actor:{uid:'63'},change:{type:'desk',outcome:'callback'}})
      vi.spyOn(db.user,'findMany').mockResolvedValueOnce(people as never)
      return Response.json({ok:true,snapshot:{version:1,complete:true,revision:NOW+12,leads:[{...source,appointmentAt:null,followupAt:NOW+3600000,stage:'Follow-up',updatedAt:NOW+11}]}})
    }) as typeof fetch
    expect((await writeAssignedLead(org,{id:dakota,name:'Dakota',role:'CLOSER'},id,{type:'desk',outcome:'callback',followupAt:NOW+3600000},{fetchImpl:send})).ok).toBe(false)
    vi.spyOn(db.user,'findFirst').mockResolvedValueOnce({email:'itsgatsby@protonmail.com'} as never)
    expect((await writeAssignedLead(org,{id:gatsby,name:'Gatsby',role:'CLOSER'},id,{type:'desk',outcome:'callback',followupAt:NOW+3600000},{fetchImpl:send})).ok).toBe(true)
    expect((await db.callCenterLead.findUniqueOrThrow({where:{id}})).nextAttemptAt?.getTime()).toBe(NOW+3600000)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('does not mark a failed or conflicting command saved, or touch another organization',async()=>{
    const send=vi.fn(async()=>Response.json({ok:false,error:'conflict'},{status:409})) as typeof fetch
    const before=await db.callCenterSlot.findFirstOrThrow({where:{leadId:id}})
    expect(await writeAssignedLead(org,actor(),id,{type:'visit',outcome:'cancelled'},{fetchImpl:send})).toMatchObject({ok:false,reason:expect.stringContaining('changed in SunOff')})
    expect((await db.callCenterSlot.findFirstOrThrow({where:{leadId:id}})).startsAt).toEqual(before.startsAt)
    expect((await writeAssignedLead(other,actor(),id,{type:'visit',outcome:'cancelled'},{fetchImpl:send})).ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
