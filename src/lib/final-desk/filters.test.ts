import {expect,it} from 'vitest'
import {BASE_FILTER_FIELDS,isUnknown,matchesFilter,matchesRule,parseClientFilter,notApplicable,comparable} from './filters'
it('distinguishes missing and unsure from No, None, zero and not applicable',()=>{
 for(const v of [null,undefined,'','unsure','not sure',[]])expect(isUnknown(v)).toBe(true)
 for(const v of [false,0,'0','No','None','N/A'])expect(isUnknown(v)).toBe(false)
 expect(notApplicable('N/A')).toBe(true);expect(notApplicable('Unknown')).toBe(false)
})
it('enforces grouped AND/OR and numeric, multi-selection and unknown comparisons',()=>{
 const fields=[...BASE_FILTER_FIELDS,{key:'tags',label:'Tags',group:'Test',type:'multi' as const}]
 const filter=parseClientFilter(JSON.stringify({operator:'AND',groups:[{operator:'AND',rules:[{field:'scheduling',operator:'equals',value:'unscheduled'}]},{operator:'OR',rules:[{field:'credit.score',operator:'unknown'},{field:'tags',operator:'all',value:['a','b']}]}]}),fields)
 expect(matchesFilter({scheduling:'unscheduled','credit.score':null,tags:[]},filter,fields)).toBe(true)
 expect(matchesFilter({scheduling:'scheduled','credit.score':null,tags:['a','b']},filter,fields)).toBe(false)
 expect(matchesFilter({scheduling:'unscheduled','credit.score':'700',tags:['b','a','c']},filter,fields)).toBe(true)
 const field=fields.find(f=>f.key==='credit.score')!
 expect(matchesRule('650-699',{field:field.key,operator:'gte',value:'650'},field)).toBe(false)
 expect(matchesRule('670',{field:field.key,operator:'between',value:['650','700']},field)).toBe(true)
 expect(matchesRule(null,{field:field.key,operator:'not_equals',value:'0'},field)).toBe(false)
})
it('rejects malformed filters and unknown fields',()=>{
 for(const raw of ['null','{',JSON.stringify({operator:'X',groups:[]}),JSON.stringify({operator:'AND',groups:[{operator:'OR',rules:[{field:'passwordHash',operator:'known'}]}]})])expect(()=>parseClientFilter(raw,BASE_FILTER_FIELDS)).toThrow()
 expect(comparable('650-699','number')).toBeNull();expect(comparable('1.9%','number')).toBe(1.9)
})
