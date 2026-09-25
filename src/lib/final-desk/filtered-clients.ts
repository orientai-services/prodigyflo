import 'server-only'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'
import { DESK_TIMEZONE, civilDate, countsAsDeskBooking, deskMonthRange } from '@/lib/daily-desk'
import { classifyDeskKind, tileState } from '@/lib/daily-desk-docs'
import { resolveCaseFacts } from '@/lib/case-facts'
import { loadDefinitions, loadSourcesForClients } from '@/lib/cys/data'
import { resolveAll } from '@/lib/cys/resolve'
import { asRecord, str } from '@/lib/packet/schema'
import { DOCUMENT_MODULES, profileCells, mergeQuestionnaire, prefillQuestionnaire, prefillFromDocuments } from './mapping'
import { QUESTIONNAIRE_NAME, QUESTIONNAIRE_VERSION, answerCount } from './questions'
import { BASE_FILTER_FIELDS, InvalidFilterError, financeKey, matchesFilter, parseClientFilter, type ClientQuery, type FilterField, type FilterValue } from './filters'
import type { FinalClient } from './types'

export async function loadFilteredClients(user: SessionUser, query: ClientQuery) {
  if(query.scheduling && query.scheduling!=='unscheduled')throw new InvalidFilterError('Unknown scheduling filter.')
  if(query.page && (!/^\d+$/.test(query.page)||Number(query.page)<1||!Number.isSafeInteger(Number(query.page))))throw new InvalidFilterError('Invalid page.')
  const now = new Date()
  const monthRange = new Map<string, { rangeStart: Date; rangeEnd: Date }>()
  const rangeFor = (timeZone: string) => {
    const zone = timeZone || DESK_TIMEZONE
    const cached = monthRange.get(zone)
    if (cached) return cached
    const range = deskMonthRange(civilDate(now, zone).slice(0, 7), zone)
    monthRange.set(zone, range)
    return range
  }
  const [rows, definitions] = await Promise.all([
    db.client.findMany({ where: clientScope(user),
      orderBy: [{ lastActivityAt:'desc' },{ id:'asc' }], select: {
        id:true,firstName:true,lastName:true,phone:true,email:true,status:true,ownerId:true,
        organization:{select:{timezone:true}},owner:{select:{name:true}},currentStage:{select:{name:true}},leadSource:{select:{name:true}},
        addresses:{orderBy:[{isPrimary:'desc'},{createdAt:'asc'}],take:1}, contracts:{take:1,select:{productType:true}},
        appointments:{orderBy:{startsAt:'desc'},select:{startsAt:true,endsAt:true,status:true,timezone:true}},
        surveyResponses:{orderBy:{updatedAt:'desc'},include:{survey:{select:{name:true,version:true}}}},
        cysFieldValues:{where:{status:'VERIFIED',verifiedById:{not:null}}},
        documents:{where:{status:{notIn:['REJECTED','EXPIRED']}},orderBy:{receivedAt:'desc'},select:{id:true,fileName:true,label:true,storageKey:true,requirement:{select:{key:true}},
          extractions:{orderBy:{createdAt:'desc'},select:{detectedTypeKey:true,sourceActive:true,status:true,fields:{select:{key:true,value:true,correctedValue:true,verification:true,sourcePage:true}}}}}},
      } }), loadDefinitions(user.organizationId),
  ])
  const sources = await loadSourcesForClients(rows.map(r=>r.id))
  const fields: FilterField[] = [...BASE_FILTER_FIELDS,
    ...DOCUMENT_MODULES.flatMap(([key,label]): FilterField[] => [
      {key:'doc.'+key,label,group:'Documents',type:'choice',options:['missing','uploaded','extracted','unverified','verified','failed']},
      {key:'doc_processing.'+key,label:label+' processing',group:'Document processing',type:'choice',options:['PENDING','RUNNING','COMPLETED','FAILED','not_started','missing']},
      {key:'doc_present.'+key,label:label+' on file',group:'Documents',type:'choice',options:['Yes','No']},
    ]),
    ...definitions.map(d=>({key:'cys.'+d.key,label:d.label,group:'CYS fields',type: ['number','currency','percent'].includes(d.dataType)?'number' as const:d.dataType==='date'?'date' as const:'text' as const})),
  ]
  const intakeKeys = new Map<string, FilterField>()
  function flatten(value: Record<string,unknown>, prefix='', out: Record<string,FilterValue>={}) {
    for(const [k,v] of Object.entries(value)) {
      if(k.startsWith('_')||/token|secret|consent/i.test(k))continue
      const key=prefix?prefix+'.'+k:k
      if(v && typeof v==='object'&&!Array.isArray(v)){flatten(v as Record<string,unknown>,key,out);continue}
      if(v===null||['string','number','boolean'].includes(typeof v)||(Array.isArray(v)&&v.every(x=>typeof x==='string')))out[key]=v as FilterValue
    }
    return out
  }
  const projected = rows.map(c=>{
    const source=asRecord(c.surveyResponses.find(r=>r.survey.name!==QUESTIONNAIRE_NAME)?.answers)
    const saved=c.surveyResponses.find(r=>r.survey.name===QUESTIONNAIRE_NAME&&r.survey.version===QUESTIONNAIRE_VERSION)
    const original=sources.get(c.id)!
    const reviewed=new Map(c.cysFieldValues.map(v=>[v.fieldKey,v]))
    const cys=resolveAll(definitions,original).map(v=>reviewed.get(v.fieldKey)??v)
    const facts=resolveCaseFacts({...c,surveyResponses:[{answers:source}],documents:c.documents.filter(d=>d.storageKey)}, {values:cys})
    const cells=profileCells(facts),address=c.addresses[0]
    const answers=mergeQuestionnaire(prefillFromDocuments(prefillQuestionnaire({name:`${c.firstName} ${c.lastName}`,phone:c.phone,email:c.email,address:address?[address.line1,address.line2,address.city,address.state,address.postalCode].filter(Boolean).join(', '):'',intake:source}),c.documents.filter(d=>d.storageKey)),asRecord(saved?.answers))
    const count=answerCount(answers),done=saved?.status==='COMPLETED'&&count===42
    const documents=c.documents.filter(d=>d.storageKey).map(d=>{
      const e=d.extractions[0],kind=classifyDeskKind({requirementKey:d.requirement?.key,detectedType:e?.detectedTypeKey,label:d.label,fileName:d.fileName})
      return {id:d.id,key:kind?.key??'other',label:d.fileName||d.label||'Document',state:tileState({hasFile:true,extractionStatus:e?.status??null,fieldCount:e?.fields.length??0,verifiedCount:e?.fields.filter(f=>['VERIFIED','CORRECTED'].includes(f.verification)).length??0})}
    })
    const agreement=documents.filter(d=>['finance_agreement','signed_contract'].includes(d.key))
    const range=rangeFor(c.organization.timezone)
    const appt=c.appointments.filter(a=>countsAsDeskBooking(a,now,range.rangeStart,range.rangeEnd)).at(-1)
    const extraction=!agreement.length?'none':agreement.every(d=>d.state==='verified')?'verified':'unverified'
    const name=String(answers.legal_name||`${facts.confirmed('first_name')||c.firstName} ${facts.confirmed('last_name')||c.lastName}`)
    const credit=cells.solar.find(s=>s.label==='Credit score')?.cell
    const row:FinalClient={id:c.id,name,state:facts.confirmed('state')||str(source.state)||address?.state||'',zip:facts.confirmed('zip')||str(source.zip)||address?.postalCode||'',stage:c.currentStage.name,owner:c.owner?.name??null,
      appointment:appt?appt.startsAt.toLocaleString('en-US',{timeZone:appt.timezone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):null,
      docs:documents,extraction,credit:credit?.kind==='value'?credit.display:null}
    const values:Record<string,FilterValue>={name,email:c.email,phone:c.phone,state:row.state,city:facts.confirmed('city')||str(source.city)||address?.city||'',zip:row.zip,stage:row.stage,closer:c.owner?.name??null,source:c.leadSource?.name??null,status:c.status,
      scheduling:appt?'scheduled':'unscheduled','appointment.history_status':[...new Set(c.appointments.map(a=>a.status))],'appointment.last_date':c.appointments[0]?civilDate(c.appointments[0].startsAt,c.organization.timezone):null,'appointment.status':appt?.status??null,'appointment.date':appt?civilDate(appt.startsAt,c.organization.timezone):null,
      'questionnaire.count':count,'questionnaire.progress':done?'completed':count?'in_progress':'not_started','credit.score':row.credit,'credit.range':facts.creditBand||null,extraction,
      'cys.progress':definitions.filter(d=>d.isRequired).every(d=>cys.some(v=>v.fieldKey===d.key&&v.status==='VERIFIED'))?'complete':'incomplete',
      'finance.payment_basis':cells.finance.find(x=>x.label==='Monthly payment')?.cell.kind==='value'?(cells.finance.find(x=>x.label==='Monthly payment')?.hint?.includes('starting')?'first_year':'contract_stated'):null,
    }
    for(const [key,value] of Object.entries(answers))values['question.'+key]=value
    for(const [key] of DOCUMENT_MODULES){const d=documents.find(d=>d.key===key);values['doc.'+key]=d?.state??'missing';values['doc_present.'+key]=d?'Yes':'No';values['doc_processing.'+key]=d?(c.documents.find(file=>file.id===d.id)?.extractions[0]?.status??'not_started'):'missing'}
    for(const cell of cells.finance)values[financeKey(cell.label)]=cell.cell.kind==='value'?cell.cell.display:cell.hint?.startsWith('Not applicable')?'Not applicable':null
    for(const cell of cells.solar)values['solar.'+cell.label.toLowerCase().replace(/ /g,'_')]=cell.cell.kind==='value'?cell.cell.display:null
    for(const value of cys)values['cys.'+value.fieldKey]=value.value
    for(const [key,value] of Object.entries(flatten(source))){values['intake.'+key]=value;intakeKeys.set(key,{key:'intake.'+key,label:key.replace(/[_.]/g,' '),group:'Intake answers',type:Array.isArray(value)?'multi':typeof value==='number'?'number':'text'})}
    return {row,values}
  })
  fields.push(...[...intakeKeys.values()].sort((a,b)=>a.key.localeCompare(b.key)))
  const filter=parseClientFilter(query.filters,fields)
  const matched=projected.filter(x=>(query.scheduling!=='unscheduled'||(x.values.status==='ACTIVE'&&x.values.scheduling==='unscheduled'))&&matchesFilter(x.values,filter,fields))
  const pageSize=40,page=Math.min(Math.max(1,Math.floor(Number(query.page)||1)),Math.max(1,Math.ceil(matched.length/pageSize)))
  return { clients:matched.slice((page-1)*pageSize,page*pageSize).map(x=>x.row), clientList:{total:matched.length,page,pageSize,fields,filters:filter,scheduling:query.scheduling==='unscheduled'?'unscheduled':undefined} }
}
