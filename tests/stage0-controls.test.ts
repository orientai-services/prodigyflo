import {describe,it,expect} from 'vitest'
import {readCohort,selectCohort} from '@/lib/intake/cohort'
import {proxy} from '../src/proxy'
import {NextRequest} from 'next/server'
import {executionAuthorized} from '@/lib/intake/execution-auth'
const leadId='11111111-1111-4111-8111-111111111111',documentId='22222222-2222-4222-8222-222222222222'
const control=()=>({mode:'synthetic',expiresAt:new Date(Date.now()+60_000).toISOString(),cases:[{leadId,documentIds:[documentId]}]})
describe('Stage 0 authorization boundaries',()=>{
 it('allows only the exact operator route past the session proxy',()=>{
  expect(proxy(new NextRequest('http://localhost/api/internal/scs/execute')).headers.get('x-middleware-next')).toBe('1')
  expect(proxy(new NextRequest('http://localhost/api/internal/scs/other')).status).toBe(307)
 })
 it('rejects malformed, empty, duplicate, and expired cohorts',()=>{
  for(const raw of ['', '{}',JSON.stringify({...control(),cases:[]}),JSON.stringify({...control(),cases:[...control().cases,...control().cases]}),JSON.stringify({...control(),expiresAt:'2000-01-01'})]) expect(()=>readCohort(raw)).toThrow()
 })
 it('refuses arbitrary exact identities even when paused',()=>{
  expect(()=>selectCohort(JSON.stringify(control()),true,{leadId:documentId})).toThrow()
  expect(()=>selectCohort(JSON.stringify(control()),true,{leadId,documentId:leadId})).toThrow()
  expect(()=>selectCohort(undefined,true,{leadId})).toThrow()
 })
 it('keeps synthetic cron work held and narrows explicit execution',()=>{
  const raw=JSON.stringify(control());expect(selectCohort(raw,false)).toBeNull();expect(selectCohort(raw,true)).toBeNull()
  expect(selectCohort(raw,true,{leadId,documentId})?.cases).toEqual([{leadId,documentIds:[documentId]}])
 })
 it('requires an explicit strong operator credential independently of cron auth',()=>{
  const old=process.env.STAGE0_EXECUTION_TOKEN
  try {delete process.env.STAGE0_EXECUTION_TOKEN;expect(executionAuthorized(new Request('http://localhost'))).toBe(false)
   process.env.STAGE0_EXECUTION_TOKEN='short';expect(executionAuthorized(new Request('http://localhost',{headers:{authorization:'Bearer short'}}))).toBe(false)
   process.env.STAGE0_EXECUTION_TOKEN='x'.repeat(40)
   expect(executionAuthorized(new Request('http://localhost',{headers:{authorization:'Bearer '+'x'.repeat(40)}}))).toBe(true)
   expect(executionAuthorized(new Request('http://localhost',{headers:{authorization:'Bearer '+'y'.repeat(40)}}))).toBe(false)
  }finally{if(old===undefined)delete process.env.STAGE0_EXECUTION_TOKEN;else process.env.STAGE0_EXECUTION_TOKEN=old}
 })
})

import * as receiverRestoration from '@/lib/intake/restoration-policy'
for (const [name,controls] of [['receiver',receiverRestoration]] as const) {
 describe(name+' persistent restoration policy',()=>{
  const p={version:1 as const,id:'temporary',cutoff:'2026-01-01T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z',organizationId:'org',sourceId:'source',excludedCaseIds:[],excludedDocumentIds:[],excludedChecksums:[]};
  it('binds admission to the exact case, policy and first eligibility date',()=>{
   const a={policy:controls.policyKey(p),caseId:leadId,eligibleAt:'2026-02-01T00:00:00.000Z'};
   expect(controls.validAdmission(p,a,leadId)).toBe(true);
   for(const change of [{caseId:documentId},{policy:'forged'},{eligibleAt:'2000-01-01'},{eligibleAt:'2099-01-01'}]) expect(controls.validAdmission(p,{...a,...change},leadId)).toBe(false);
   expect(controls.validAdmission({...p,excludedCaseIds:[leadId]},a,leadId)).toBe(false);
  });
  it('survives deadline renewal but never silently changes the cutoff or source',()=>{
   expect(controls.policyKey({...p,expiresAt:'2098-01-01T00:00:00.000Z'})).toBe(controls.policyKey(p));
   for(const change of [{cutoff:'2026-02-01T00:00:00.000Z'},{sourceId:'other'},{organizationId:'other'},{id:'other'}]) expect(controls.policyKey({...p,...change})).not.toBe(controls.policyKey(p));
  });
  it('fails closed for missing, malformed, expired and invalid-exclusion settings',()=>{
   const raw=process.env.SCS_RESTORATION_POLICY,required=process.env.SCS_RESTORATION_REQUIRED;
   try {process.env.SCS_RESTORATION_REQUIRED='true';delete process.env.SCS_RESTORATION_POLICY;expect(()=>controls.readRestorationPolicy()).toThrow();
    for(const bad of ['{}','{',JSON.stringify({...p,expiresAt:'2000-01-01'}),JSON.stringify({...p,excludedCaseIds:['anything']}),JSON.stringify({...p,excludedChecksums:['bad']}),JSON.stringify({...p,cutoff:'2026-01-01'})]){process.env.SCS_RESTORATION_POLICY=bad;expect(()=>controls.readRestorationPolicy()).toThrow();}
    process.env.SCS_RESTORATION_POLICY=JSON.stringify(p);expect(controls.readRestorationPolicy()).toEqual(p);
   }finally{if(raw===undefined)delete process.env.SCS_RESTORATION_POLICY;else process.env.SCS_RESTORATION_POLICY=raw;if(required===undefined)delete process.env.SCS_RESTORATION_REQUIRED;else process.env.SCS_RESTORATION_REQUIRED=required;}
  });
 });
}
