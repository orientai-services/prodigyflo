import { requireUser } from '@/lib/rbac'
import { savedUserLanguage, saveUserLanguage } from '@/lib/user-language'
const answer=(status:number,body:unknown)=>Response.json(body,{status,headers:{'cache-control':'no-store'}})
export async function GET(){
  const user=await requireUser()
  return answer(200,{userId:user.id,language:await savedUserLanguage(user.organizationId,user.id)})
}
export async function POST(request:Request){
  const user=await requireUser()
  let body: {userId?:unknown;language?:unknown}
  try{const text=await request.text();if(text.length>500)return answer(413,{ok:false});body=JSON.parse(text)}catch{return answer(400,{ok:false})}
  if(!body || typeof body !== 'object' || Array.isArray(body))return answer(400,{ok:false})
  if(body.userId!==user.id)return answer(409,{ok:false,error:'identity_changed'})
  if(body.language!=='en' && body.language!=='es')return answer(400,{ok:false})
  await saveUserLanguage(user.organizationId,user.id,body.language)
  return answer(200,{ok:true,userId:user.id,language:body.language})
}
