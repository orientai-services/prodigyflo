import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { UiLocale } from './ui-locale'
const object = (v: unknown): Record<string,unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {}
export async function savedUserLanguage(organizationId: string, userId: string): Promise<UiLocale | null> {
  const org=await db.organization.findUnique({where:{id:organizationId},select:{settings:true}})
  const value=object(object(org?.settings).staffLanguages)[userId]
  return value === 'en' || value === 'es' ? value : null
}
export async function saveUserLanguage(organizationId: string, userId: string, language: UiLocale) {
  await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`
    const org=await tx.organization.findUniqueOrThrow({where:{id:organizationId},select:{settings:true}})
    const settings=object(org.settings)
    await tx.organization.update({where:{id:organizationId},data:{settings:{...settings,
      staffLanguages:{...object(settings.staffLanguages),[userId]:language}} as Prisma.InputJsonValue}})
  })
}
export async function userAudioLanguage(organizationId: string, userId: string | null | undefined): Promise<UiLocale> {
  return userId ? await savedUserLanguage(organizationId,userId) ?? 'en' : 'en'
}
