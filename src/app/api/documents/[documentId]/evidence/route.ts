import { can, getSessionUser } from '@/lib/rbac'
import { findDocumentInScope } from '@/lib/storage/access'
import { signedDocumentFileUrl } from '@/lib/storage'
import {currentExtractionFields} from '@/lib/desk-extract'
import { db } from '@/lib/db'

export async function GET(_request: Request, ctx: {params:Promise<{documentId:string}>}) {
  const user=await getSessionUser()
  if(!user) return Response.json({error:'Unauthorized'},{status:401})
  if(!can(user,'documents:read')) return Response.json({error:'Forbidden'},{status:403})
  const {documentId}=await ctx.params
  const doc=await findDocumentInScope(user,documentId)
  if(!doc) return Response.json({error:'Not found'},{status:404})
  const extractions=await db.documentExtraction.findMany({where:{documentId},orderBy:{createdAt:'desc'},select:{
    id:true,detectedTypeKey:true,sourceActive:true,status:true,provider:true,model:true,summary:true,error:true,pageCount:true,createdAt:true,warnings:true,
    fields:{select:{key:true,label:true,value:true,correctedValue:true,verification:true,sourcePage:true,sourceSnippet:true,conflictNote:true,reviewerNote:true}},
  }})
  const imported=await db.externalDocumentImport.findUnique({where:{clientDocumentId:documentId},select:{analysisPending:true,analysisError:true,analysisAttempts:true}})
  const job=await db.recordsAnalysisJob.findUnique({where:{documentId},select:{status:true,error:true,attempts:true}})
  const latest=extractions[0]
  const extraction=latest?{...latest,fields:currentExtractionFields(extractions).map(({field})=>field)}:null
  return Response.json({documentId,fileName:doc.fileName,version:doc.version,mimeType:doc.mimeType,fileUrl:await signedDocumentFileUrl(doc),extraction,processing:imported?{status:imported.analysisPending?'PENDING':imported.analysisError?'PAUSED':'COMPLETE',error:imported.analysisError,attempts:imported.analysisAttempts}:job},
    {headers:{'Cache-Control':'private, no-store'}})
}
