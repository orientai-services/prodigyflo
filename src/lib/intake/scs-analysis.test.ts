import {describe,it,expect,vi} from 'vitest'
vi.mock('@/lib/db',()=>({db:{}}))
import {analysisFields,typeFor} from './scs-analysis'
const fact={value:'2.9',confidence:'high' as const,page:1,quote:'2.9%',document_id:'doc',source:'contract.pdf',run_id:'run',provider:'records' as const,model:'model',staff_review_required:true}
const doc={documentId:'doc',sha256:'a'.repeat(64),fields:{escalator_rate:fact},classification:['ppa'],readableAgreement:true,clientMatch:'matched' as const,coverage:{complete:true as const,totalPages:9,processedPages:9},runs:['run']}
const review=(accepted:string,action='accepted')=>({action,accepted,source_evidence:fact})
describe('PF evidence field mapping',()=>{
 it('maps reviewed escalation without turning it into APR',()=>{const fields=analysisFields({...doc,reviewDecisions:{escalator_rate:review('2.9')}});expect(fields[0]).toMatchObject({key:'escalator_pct',value:'2.9'});expect(fields.some(f=>f.key==='apr')).toBe(false)})
 it('preserves first-year/current payments and separates provider from servicer',()=>{
  const fields=analysisFields({...doc,fields:{first_year_monthly_payment:{...fact,value:'57.97'},monthly_solar_payment:{...fact,value:null},lender_servicer:{...fact,value:'Sunrun'},servicer:{...fact,value:'Service Co'}},reviewDecisions:{first_year_monthly_payment:review('57.97'),lender_servicer:review('Sunrun'),servicer:review('Service Co')}})
  expect(fields.map(f=>[f.key,f.value])).toEqual([['first_year_monthly_payment','57.97'],['monthly_payment',null],['contract_counterparty','Sunrun'],['servicer_name','Service Co']])
 })
 it('imports the customer-selected alternative but keeps it unverified by staff',()=>{
  expect(analysisFields({...doc,fields:{escalator_rate:{...fact,value:null}},reviewDecisions:{escalator_rate:review('1.9')}})[0]).toMatchObject({value:'1.9',verification:'UNVERIFIED'})
 })
 it('shows unreviewed Document Intelligence values as unverified desk proposals',()=>{
  expect(analysisFields({...doc,reviewDecisions:{}})[0].value).toBe('2.9')
 })
 it('leaves rejected and incorrectly bound proposals out of business values',()=>{
  for(const reviewDecisions of [{escalator_rate:review('2.9','rejected')},{escalator_rate:{action:'accepted',accepted:'2.9'}},{escalator_rate:{...review('2.9'),source_evidence:{...fact,run_id:'old-run'}}}]) {
   expect(analysisFields({...doc,reviewDecisions})[0].value).toBeNull()
   expect(doc.fields.escalator_rate.value).toBe('2.9')
  }
 })
 it('accepts explicit customer corrections without promoting them to staff verification',()=>{
  expect(analysisFields({...doc,reviewDecisions:{escalator_rate:review('1.9','edited')}})[0]).toMatchObject({value:'1.9',sourcePage:null,sourceSnippet:null,verification:'UNVERIFIED'})
 })
 it('keeps unclear client values unknown and honors the actual loan classification',()=>{
  expect(analysisFields({...doc,clientMatch:'unclear'})[0].value).toBeNull()
  expect(typeFor({...doc,classification:['loan']})).toBe('finance_agreement')
 })
 it('classifies install, lender, and utility packets onto the matching desk type',()=>{
  expect(typeFor({...doc,classification:['loan_or_til'],fields:{}})).toBe('finance_agreement')
  expect(typeFor({...doc,classification:['ric'],fields:{agreement_type:{...fact,value:'Retail Installment Contract'}}})).toBe('finance_agreement')
  expect(typeFor({...doc,classification:['signed_contract'],fields:{}})).toBe('solar_contract')
  expect(typeFor({...doc,classification:['solar_contract'],fields:{agreement_type:{...fact,value:'ppa'}}})).toBe('solar_contract')
  expect(typeFor({...doc,classification:['utility_bill'],fields:{}})).toBe('utility_bill')
 })
 it('materializes remaining, cash price, and utility bill amount from unreviewed extracts',()=>{
  const fields=analysisFields({...doc,classification:['ppa'],fields:{
    remaining_balance:{...fact,value:'64212.83'},
    cash_price:{...fact,value:'68259.51'},
    monthly_utility_bill:{...fact,value:'166.53'},
  },reviewDecisions:{}})
  expect(fields).toEqual(expect.arrayContaining([
    expect.objectContaining({key:'remaining_balance',value:'64212.83'}),
    expect.objectContaining({key:'cash_price',value:'68259.51'}),
    expect.objectContaining({key:'amount_due',value:'166.53'}),
  ]))
 })
})
