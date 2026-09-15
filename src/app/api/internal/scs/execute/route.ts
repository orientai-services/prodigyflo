import { executionAuthorized } from '@/lib/intake/execution-auth'
import { runPendingScsDocumentImports } from '@/lib/intake/scs-document-import'
export const maxDuration=300
export async function POST(request: Request) {
 if (!executionAuthorized(request)) return Response.json({error:'Unauthorized'},{status:401})
 try {
 const {leadId,documentId}=await request.json()
 if (typeof leadId!=='string'||typeof documentId!=='string') return Response.json({error:'Exact identities required'},{status:400})
 return Response.json(await runPendingScsDocumentImports(1,{leadId,documentId}))
 } catch { return Response.json({error:'Execution refused or incomplete; inspect saved state'},{status:409}) }
}
