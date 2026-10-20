import 'server-only'
import { db } from '@/lib/db'
import { phoneHashOrNull } from './compliance-core'
import { normalisePhone } from '@/lib/dedupe'
import { userAudioLanguage } from '@/lib/user-language'
import type { UiLocale } from '@/lib/ui-locale'

/** Customer prompts follow the customer; staff prompts follow the signed-in user. */
export async function callerAudioLanguage(organizationId: string, phone: string): Promise<UiLocale> {
  const normalized=normalisePhone(phone)
  if(normalized.length < 10)return 'en'
  const users=await db.user.findMany({where:{organizationId,isActive:true,deletedAt:null,phone:{not:null}},select:{id:true,phone:true}})
  const user=users.find(u=>normalisePhone(u.phone ?? '')===normalized)
  if(user)return userAudioLanguage(organizationId,user.id)
  const clients=await db.client.findMany({where:{organizationId,deletedAt:null,phone:{contains:normalized.slice(-4)}},select:{phone:true,preferredLanguage:true}})
  const client=clients.find(c=>normalisePhone(c.phone ?? '')===normalized)
  if(client)return /^es|^spanish/i.test(client.preferredLanguage) ? 'es' : 'en'
  const hash=phoneHashOrNull(phone)
  const lead=hash ? await db.callCenterLead.findFirst({where:{organizationId,phoneHash:hash},select:{language:true}}) : null
  return lead?.language === 'ES' ? 'es' : 'en'
}
