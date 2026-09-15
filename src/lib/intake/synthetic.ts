import 'server-only'
import { db } from '@/lib/db'
export async function isSyntheticClient(clientId: string): Promise<boolean> {
 const row=await db.intakeSubmission.findFirst({where:{clientId,rawPayload:{path:['stage0_synthetic'],equals:true}},select:{id:true}})
 return !!row
}
