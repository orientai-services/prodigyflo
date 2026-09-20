import {beforeAll,afterAll,it,expect} from 'vitest'
import {db} from '@/lib/db'
import {scheduleAppointment} from '@/lib/scheduling'
import {clientScope,type SessionUser} from '@/lib/rbac'
import {ALL_PERMISSIONS,CLOSER_PERMISSIONS} from '@/lib/permissions'
import {loadDeskBoard} from '@/lib/daily-desk-data'
import {loadFilteredClients} from '@/lib/final-desk/filtered-clients'
import {loadFinalQuestionnaire} from '@/lib/final-desk/data'
import {SCHEMA_42_FIELDS} from '../prisma/seeds/cys'
import {retiredIdentityHash,isRetiredIdentity} from '@/lib/retired-identities'
import {QUESTIONNAIRE_NAME,QUESTIONNAIRE_VERSION} from '@/lib/final-desk/questions'
let org:string,client:string,admin:SessionUser,closer:SessionUser,other:SessionUser
const stamp=`schedule-${Date.now()}`
beforeAll(async()=>{
 org=(await db.organization.create({data:{name:'Isolated schedule tests',slug:stamp}})).id
 async function staff(name:string,key:'SUPER_ADMIN'|'CLOSER'){
  const role=await db.role.upsert({where:{organizationId_key:{organizationId:org,key}},update:{},create:{organizationId:org,key,name:key}})
  const row=await db.user.create({data:{organizationId:org,roleId:role.id,name,email:`${stamp}-${name}@example.test`,passwordHash:'test-only'}})
  return {...row,role:key,roleName:key,organizationName:'Isolated schedule tests',portalClientId:null,permissions:new Set(key==='SUPER_ADMIN'?ALL_PERMISSIONS:CLOSER_PERMISSIONS)} as SessionUser
 }
 admin=await staff('admin','SUPER_ADMIN');closer=await staff('closer','CLOSER');other=await staff('other','CLOSER')
 const pipe=await db.pipeline.create({data:{organizationId:org,name:'Test'}})
 const stage=await db.pipelineStage.create({data:{pipelineId:pipe.id,key:'NEW_LEAD',name:'New',position:0,category:'INTAKE'}})
 client=(await db.client.create({data:{organizationId:org,pipelineId:pipe.id,currentStageId:stage.id,ownerId:closer.id,firstName:'Synthetic',lastName:'Main',email:'synthetic@example.test',phone:'2025550100'}})).id
 await db.client.createMany({data:Array.from({length:44},(_,i)=>({organizationId:org,pipelineId:pipe.id,currentStageId:stage.id,ownerId:other.id,firstName:'Synthetic',lastName:`Other ${i}`,email:`other${i}@example.test`,phone:'2025550101'}))})
 await db.cysFieldDefinition.createMany({data:SCHEMA_42_FIELDS.map(d=>({...d,organizationId:org}))})
 const survey=await db.survey.create({data:{organizationId:org,name:'SCS intake',version:1,schema:{}}})
 await db.surveyResponse.create({data:{clientId:client,surveyId:survey.id,status:'COMPLETED',answers:{credit_band:'650-699',product_type_guess:'ppa',mo_pay:'999',active_bankruptcy:'No',custom_zero:0,private_other:'only-my-client'}}})
 const manual=await db.survey.create({data:{organizationId:org,name:QUESTIONNAIRE_NAME,version:QUESTIONNAIRE_VERSION,schema:{}}})
 await db.surveyResponse.create({data:{clientId:client,surveyId:manual.id,answers:{mo_pay:'57.97',_manual:{mo_pay:{actor:closer.id}}}}})
 await db.clientDocument.create({data:{clientId:client,label:'solar_contract',fileName:'synthetic-ppa.pdf',storageKey:'synthetic-only',status:'RECEIVED',receivedAt:new Date(),extractions:{create:{status:'FAILED',provider:'test',error:'Synthetic interruption'}}}})
})
afterAll(async()=>{if(org)await db.organization.delete({where:{id:org}});await db.retiredIdentity.deleteMany({where:{id:retiredIdentityHash('scs-lead',stamp)}});await db.$disconnect()})
const input=(key:string,user=admin)=>({organizationId:org,clientId:client,scope:clientScope(user),requestKey:key,startsAt:new Date('2090-01-01T18:00:00Z'),endsAt:new Date('2090-01-01T19:00:00Z'),timezone:'America/Los_Angeles'})
it('serializes simultaneous bookings and replays one durable result',async()=>{
 const results=await Promise.all(['one','two'].map(key=>db.$transaction(tx=>scheduleAppointment(tx,input(key)))))
 expect(results.filter(r=>r.outcome==='SAVED')).toHaveLength(1)
 expect(results.filter(r=>r.outcome==='CONFLICT')).toHaveLength(1)
 expect(await db.appointment.count({where:{clientId:client}})).toBe(1)
 const winner=results[0].ok?'one':'two'
 const replay=await db.$transaction(tx=>scheduleAppointment(tx,input(winner)))
 expect(replay.outcome).toBe('REPLAYED');expect(replay.appointmentId).toBe(results.find(r=>r.ok)?.appointmentId)
 const board=await loadDeskBoard(admin,'2090-01')
 expect(board.unscheduledTotal).toBe(44);expect(board.unscheduled.length).toBeLessThanOrEqual(20)
 expect(board.unscheduled.some(c=>c.clientId===client)).toBe(false)
})
it('rejects another closer and stale reschedules, then preserves edits through import replays',async()=>{
 const original=await db.appointment.findFirstOrThrow({where:{clientId:client}})
 const denied=await db.$transaction(tx=>scheduleAppointment(tx,input('denied',other)));expect(denied.ok).toBe(false)
 const stale=await db.$transaction(tx=>scheduleAppointment(tx,{...input('stale'),appointmentId:original.id,expectedUpdatedAt:'2000-01-01T00:00:00.000Z'}));expect(stale.ok).toBe(false)
 const moved=await db.$transaction(tx=>scheduleAppointment(tx,{...input('move',closer),appointmentId:original.id,expectedUpdatedAt:original.updatedAt.toISOString(),startsAt:new Date('2090-01-02T18:00:00Z'),endsAt:new Date('2090-01-02T19:00:00Z')}));expect(moved.ok).toBe(true);expect(moved.appointmentId).toBe(original.id)
 const conflict=await db.$transaction(tx=>scheduleAppointment(tx,{...input('provider-race'),imported:true,externalEventId:'synthetic-event'}));expect(conflict.outcome).toBe('CONFLICT')
 expect((await db.appointment.findUniqueOrThrow({where:{id:original.id}})).startsAt.toISOString()).toBe(moved.startsAt)
 await db.appointment.update({where:{id:original.id},data:{status:'CANCELLED'}})
 const replay=await db.$transaction(tx=>scheduleAppointment(tx,{...input('move',closer),appointmentId:original.id,expectedUpdatedAt:original.updatedAt.toISOString()}));expect(replay.status).toBe('CANCELLED')
 expect(await db.appointment.count({where:{clientId:client}})).toBe(1)
})
it('counts running calls as scheduled, rejects new/past bookings, and releases terminal calls',async()=>{
 const ongoing=await db.appointment.create({data:{clientId:client,ownerId:closer.id,startsAt:new Date(Date.now()-60000),endsAt:new Date(Date.now()+600000)}})
 expect((await loadDeskBoard(closer)).unscheduledTotal).toBe(0)
 expect((await db.$transaction(tx=>scheduleAppointment(tx,input('during-call')))).outcome).toBe('CONFLICT')
 await db.appointment.update({where:{id:ongoing.id},data:{status:'NO_SHOW'}})
 expect((await loadDeskBoard(closer)).unscheduledTotal).toBe(1)
 expect((await db.$transaction(tx=>scheduleAppointment(tx,{...input('past'),startsAt:new Date('2020-01-01'),endsAt:new Date('2020-01-02')}))).ok).toBe(false)
})
it('filters before pagination, shares manual answers, and prevents cross-closer options/count leakage',async()=>{
 const raw={operator:'AND',groups:[{operator:'OR',rules:[{field:'credit.score',operator:'unknown'},{field:'doc.signed_contract',operator:'equals',value:'failed'}]},{operator:'AND',rules:[{field:'question.mo_pay',operator:'equals',value:'57.97'}]}]}
 const result=await loadFilteredClients(admin,{filters:JSON.stringify(raw),scheduling:'unscheduled'})
 expect(result.clients.map(c=>c.id)).toEqual([client]);expect(result.clientList.total).toBe(1)
 const q=await loadFinalQuestionnaire(closer,client);expect(q?.answers.mo_pay).toBe('57.97')
 expect(result.clients[0].docs[0].state).toBe('failed');expect(result.clients[0].credit).toBeNull()
 const mine=await loadFilteredClients(closer,{});expect(mine.clientList.total).toBe(1)
 const theirs=await loadFilteredClients(other,{});expect(theirs.clientList.total).toBe(44);expect(theirs.clientList.fields.some(f=>f.key==='intake.private_other')).toBe(false)
 const second=await loadFilteredClients(admin,{page:'2'});expect(second.clients).toHaveLength(5);expect(second.clientList.total).toBe(45)
 expect(new Set([...(await loadFilteredClients(admin,{})).clients,...second.clients].map(c=>c.id)).size).toBe(45)
})
it('retains only identity hashes and permits fresh source IDs',async()=>{
 await db.retiredIdentity.create({data:{id:retiredIdentityHash('scs-lead',stamp)}})
 expect(await isRetiredIdentity([['scs-lead',stamp]])).toBe(true)
 expect(await isRetiredIdentity([['scs-lead',stamp+'-new']])).toBe(false)
})
