import {afterAll,beforeAll,expect,it,vi} from 'vitest'
import {db} from '@/lib/db'
import {ALL_PERMISSIONS,CLOSER_PERMISSIONS} from '@/lib/permissions'
import {can,ForbiddenError,type SessionUser} from '@/lib/rbac'
import {saveFinalQuestionnaire} from '@/lib/final-desk/actions'
import {loadFinalQuestionnaire} from '@/lib/final-desk/data'
import {QUESTIONNAIRE_NAME,QUESTIONS,emptyAnswers} from '@/lib/final-desk/questions'
const state=vi.hoisted(()=>({actor:null as SessionUser|null}))
vi.mock('@/lib/rbac',async(original)=>({...await original<typeof import('@/lib/rbac')>(),requirePermission:async(key:Parameters<typeof can>[1])=>{if(!state.actor||!can(state.actor,key))throw new ForbiddenError();return state.actor}}))
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}))
let org:string,client:string,survey:string,admin:SessionUser,closer:SessionUser,stranger:SessionUser
const stamp=`final-q-${Date.now()}`
beforeAll(async()=>{
 process.env.PRODIGYFLO_FINAL_DESK='true'
 org=(await db.organization.create({data:{name:'Questionnaire test',slug:stamp}})).id
 async function staff(name:string,key:'SUPER_ADMIN'|'CLOSER'){
  const role=await db.role.upsert({where:{organizationId_key:{organizationId:org,key}},update:{},create:{organizationId:org,key,name:key}})
  const u=await db.user.create({data:{organizationId:org,roleId:role.id,name,email:`${stamp}-${name}@example.test`,passwordHash:'local-test-only'}})
  return {...u,role:key,roleName:key,organizationName:'Questionnaire test',portalClientId:null,permissions:new Set(key==='SUPER_ADMIN'?ALL_PERMISSIONS:CLOSER_PERMISSIONS)} as SessionUser
 }
 admin=await staff('admin','SUPER_ADMIN');closer=await staff('closer','CLOSER');stranger=await staff('stranger','CLOSER')
 const pipe=await db.pipeline.create({data:{organizationId:org,name:'Test'}})
 const stage=await db.pipelineStage.create({data:{pipelineId:pipe.id,key:'NEW_LEAD',name:'New',position:0,category:'INTAKE'}})
 client=(await db.client.create({data:{organizationId:org,pipelineId:pipe.id,currentStageId:stage.id,ownerId:closer.id,firstName:'Test',lastName:'Client',email:'test@example.test',phone:'2025550100'}})).id
 survey=(await db.survey.create({data:{organizationId:org,name:'SCS intake',version:1,schema:{}}})).id
 await db.surveyResponse.create({data:{clientId:client,surveyId:survey,status:'COMPLETED',answers:{product_type_guess:'ppa',monthly_guess:'100'}}})
})
afterAll(async()=>{if(org)await db.organization.delete({where:{id:org}});delete process.env.PRODIGYFLO_FINAL_DESK;await db.$disconnect()})
it('denies another closer and persists assigned staff edits without overwriting intake',async()=>{
 state.actor=stranger
 expect(await loadFinalQuestionnaire(stranger,client)).toBeNull()
 expect((await saveFinalQuestionnaire({clientId:client,answers:emptyAnswers(),touched:[],page:0,revision:0})).ok).toBe(false)
 state.actor=closer
 const initial=(await loadFinalQuestionnaire(closer,client))!
 expect(initial.answers.agree_type).toEqual(['PPA (Power Purchase Agreement)'])
 const result=await saveFinalQuestionnaire({clientId:client,answers:{...initial.answers,mo_pay:'',on_contract:'Reviewed client'},touched:['mo_pay','on_contract'],page:1,revision:0})
 expect(result).toMatchObject({ok:true,revision:1})
 await db.surveyResponse.updateMany({where:{clientId:client,surveyId:survey},data:{answers:{monthly_guess:'999',product_type_guess:'loan'}}})
 const reloaded=(await loadFinalQuestionnaire(admin,client))!
 expect(reloaded.answers.mo_pay).toBe('');expect(reloaded.answers.on_contract).toBe('Reviewed client');expect(reloaded.page).toBe(1)
 expect(reloaded.answers.agree_type).toEqual(['Loan'])
 expect(await db.surveyResponse.count({where:{clientId:client,surveyId:survey}})).toBe(1)
})
it('rejects stale sessions and incomplete Complete without changing saved data',async()=>{
 state.actor=admin
 const current=(await loadFinalQuestionnaire(admin,client))!
 const stale=await saveFinalQuestionnaire({clientId:client,answers:current.answers,touched:[],page:0,revision:0})
 expect(stale.error).toContain('another session')
 const incomplete=await saveFinalQuestionnaire({clientId:client,answers:current.answers,touched:[],page:8,revision:1,complete:true})
 expect(incomplete.error).toContain('42')
 expect((await loadFinalQuestionnaire(admin,client))?.revision).toBe(1)
})
it('serializes simultaneous edits and creates only one questionnaire response',async()=>{
 const current=(await loadFinalQuestionnaire(admin,client))!
 const raw={clientId:client,answers:{...current.answers,on_contract:'Concurrent'},touched:['on_contract'],page:2,revision:1}
 const results=await Promise.all([saveFinalQuestionnaire(raw),saveFinalQuestionnaire(raw)])
 expect(results.filter(r=>r.ok)).toHaveLength(1)
 expect(await db.surveyResponse.count({where:{clientId:client,survey:{name:QUESTIONNAIRE_NAME}}})).toBe(1)
})
it('completes and reloads all 42 answers with staff attribution',async()=>{
 const answers=Object.fromEntries(QUESTIONS.map(q=>[q.id,q.ty==='multi'?[q.o![0]]:q.ty==='one'?q.o![0]:'Explicit local test answer']))
 expect(await saveFinalQuestionnaire({clientId:client,answers,touched:QUESTIONS.map(q=>q.id),page:8,revision:2,complete:true})).toMatchObject({ok:true,revision:3})
 expect((await loadFinalQuestionnaire(admin,client))?.done).toBe(true)
 const saved=await db.surveyResponse.findFirstOrThrow({where:{clientId:client,survey:{name:QUESTIONNAIRE_NAME}}})
 expect(Object.keys((saved.answers as Record<string,object>)._manual)).toHaveLength(42)
})
