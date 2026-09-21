import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { answerCount, emptyAnswers, QUESTIONS, validateAnswers } from './questions'
import { mergeQuestionnaire, prefillQuestionnaire, prefillFromDocuments, profileCells } from './mapping'
import type { CaseFileData } from '@/lib/daily-desk-case-types'

const identity = {name:'Test Client',address:'123 Example Lane',phone:'2025550100',email:'test@example.test'}
describe('final HTML questionnaire and projection', () => {
  it('preserves the 42 exact question IDs in the supplied prototype', () => {
    const source = readFileSync('docs/reference/final-prototype-14.html','utf8')
    const ids = [...source.matchAll(/\{id:"([a-z_0-9]+)",l:/g)].map(m=>m[1])
    expect(QUESTIONS.map(q=>q.id)).toEqual(ids)
    expect(new Set(ids).size).toBe(42)
    expect(Object.keys(emptyAnswers())).toHaveLength(42)
  })
  it('maps PPA intake without assuming ownership, current price, or sales conduct', () => {
    const a=prefillQuestionnaire({...identity,intake:{product_type_guess:'ppa',credit_score_band:'650-699',payments_current:true}})
    expect(a.agree_type).toEqual(['PPA (Power Purchase Agreement)'])
    expect(a.sole_owner).toBe(''); expect(a.pressure).toEqual([]); expect(a.mo_pay).toBe('')
    expect(answerCount(a)).toBe(5)
  })
  it('prefills supported document facts while qualifying historical PPA payment', () => {
    const fields = {product_type:'ppa',first_year_monthly_payment:'57.97',escalator_pct:'1.9',term_years:'20',customer_signed_date:'2018-05-28',contract_counterparty:'Sunrun'}
    const docs=[{extractions:[{detectedTypeKey:'solar_contract',status:'COMPLETED',fields:Object.entries(fields).map(([key,value])=>({key,value,correctedValue:null,verification:'UNVERIFIED',sourcePage:1}))}]}]
    const a=prefillFromDocuments(emptyAnswers(),docs)
    expect(a.agree_type).toEqual(['PPA (Power Purchase Agreement)'])
    expect(a.mo_pay).toContain('first-year'); expect(a.mo_pay).toContain('not current bill')
    expect(a.term_yrs).toBe('20 years'); expect(a.year_signed).toBe('2018'); expect(a.escalator).toBe('Yes')
    expect(a.lender).toBe(''); expect(a.working).toBe(''); expect(a.credit_ck).toBe('')
    expect(mergeQuestionnaire(a,{mo_pay:'Reviewed current payment',_manual:{mo_pay:{actorId:'staff'}}}).mo_pay).toBe('Reviewed current payment')
  })
  it('preserves deliberate staff blanks and corrections across changed imports', () => {
    const base=prefillQuestionnaire({...identity,intake:{monthly_payment_guess:'100'}})
    const a=mergeQuestionnaire(base,{mo_pay:'',legal_name:'Reviewed Name',_manual:{mo_pay:{actorId:'staff'},legal_name:{actorId:'staff'}}})
    expect(a.mo_pay).toBe(''); expect(a.legal_name).toBe('Reviewed Name'); expect(a.email).toBe(identity.email)
  })
  it('requires truthful exclusive None and rejects unsupported keys/options', () => {
    expect(()=>validateAnswers({pressure:['None','Limited-time offer']})).toThrow('None')
    expect(()=>validateAnswers({hardship:['No hardship','Behind on payments']})).toThrow('None')
    expect(()=>validateAnswers({sole_owner:'Probably'})).toThrow('Invalid selection')
    expect(()=>validateAnswers({extra:'value'})).toThrow('Unknown question')
    expect(validateAnswers({pressure:['None'],promises:['None']})).toMatchObject({pressure:['None'],promises:['None']})
  })
  it('keeps the fixed 17 tiles while preserving PPA financial meaning', () => {
    const fixture={finance:[
      {label:'First-year monthly payment',cell:{kind:'value',display:'$57.97'},hint:'Contract starting amount; not today’s bill'},
      {label:'Annual payment escalation',cell:{kind:'value',display:'1.9%'}},
      {label:'Customer signature date',cell:{kind:'value',display:'2018-05-28'}},
      {label:'Term months',cell:{kind:'value',display:'240'}},
    ],solar:[{label:'Agreement type',cell:{kind:'value',display:'ppa'}},{label:'Credit range',cell:{kind:'value',display:'650–699'}}]} as CaseFileData
    const {finance,solar}=profileCells(fixture)
    expect(finance).toHaveLength(13);expect(solar).toHaveLength(4)
    expect(finance.find(c=>c.label==='Interest rate')?.cell).toMatchObject({kind:'value',display:'N/A'})
    expect(finance.find(c=>c.label==='Annual Escalator Rate %')?.cell).toMatchObject({display:'1.9%'})
    expect(finance.find(c=>c.label==='First payment date')?.cell).toMatchObject({kind:'value',display:'2018-05-28'})
    expect(finance.find(c=>c.label==='Monthly payment')).toMatchObject({cell:{display:'$57.97'},hint:expect.stringContaining('not today')})
    expect(solar.find(c=>c.label==='Credit score')?.cell).toMatchObject({kind:'value',display:'650–699'})
  })
})
