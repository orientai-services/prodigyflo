import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { db } from '@/lib/db'
import { makeOrg,makeUser,testNumber } from './fixtures/telephony'
import { savedUserLanguage,saveUserLanguage,userAudioLanguage } from '@/lib/user-language'
import { callerAudioLanguage } from '@/lib/telephony/audio-language'
import { sayAndHangup,whisperTwiml,callbackOfferTwiml,voicemailTwiml } from '@/lib/telephony/twiml'
const run=`audio-${Date.now().toString(36)}`
describe('recipient language',()=>{
 let org:string,other:string,user:Awaited<ReturnType<typeof makeUser>>
 beforeAll(async()=>{
  org=(await makeOrg(run,'Audio')).orgId;other=(await makeOrg(run,'Other')).orgId
  user=await makeUser(org,run,'Audio Listener','CLOSER')
  await db.user.update({where:{id:user.id},data:{phone:testNumber(run,1)}})
  await db.organization.update({where:{id:org},data:{settings:{unrelated:{keep:true}}}})
 })
 afterAll(async()=>{for(const id of [org,other])if(id)await db.organization.delete({where:{id}})})
 it('persists each user independently without replacing organization settings',async()=>{
  expect(await savedUserLanguage(org,user.id)).toBeNull()
  await saveUserLanguage(org,user.id,'es')
  expect(await userAudioLanguage(org,user.id)).toBe('es')
  expect(await userAudioLanguage(other,user.id)).toBe('en')
  expect((await db.organization.findUniqueOrThrow({where:{id:org}})).settings).toMatchObject({unrelated:{keep:true}})
  await saveUserLanguage(org,user.id,'en')
  expect(await callerAudioLanguage(org,testNumber(run,1))).toBe('en')
  await saveUserLanguage(org,user.id,'es')
  expect(await callerAudioLanguage(org,testNumber(run,1))).toBe('es')
  expect(await callerAudioLanguage(other,testNumber(run,1))).toBe('en')
 })
 it('matches the text and voice for staff errors and customer disclosures',()=>{
  expect(sayAndHangup('The line is busy.','es')).toContain('La línea está ocupada.')
  expect(sayAndHangup('The line is busy.','es')).toContain('language="es-MX"')
  expect(sayAndHangup('The line is busy.','en')).toContain('The line is busy.')
  expect(whisperTwiml('es')).toContain('Esta llamada puede ser grabada')
  expect(whisperTwiml('en')).not.toContain('Esta llamada')
  const config={voicemailCallbackUrl:'https://example.test/vm',gatherActionUrl:'https://example.test/cb',language:'es' as const}
  expect(callbackOfferTwiml(config)).toContain('presione 1')
  expect(callbackOfferTwiml(config)).not.toContain('Sorry we missed')
  expect(voicemailTwiml(config)).toContain('Deje su nombre')
 })
})
