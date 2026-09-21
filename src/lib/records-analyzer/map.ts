// Synchronized from SCS Records adapter, 2026-09-20.
import type { BatchFile } from './prepare';
export const FIELD_MAP: Record<string,string> = {
  contract_type:'agreement_type',contract_date:'customer_signed_date',effective_date:'effective_date',in_service_date:'in_service_date',first_payment_date:'first_payment_date',
  installer:'installer',sales_company:'sales_company',finance_company:'lender_servicer',servicer:'servicer',
  system_size_kw:'system_size',apr_pct:'interest_rate',escalator_pct:'escalator_rate',term_years:'term_years',payment_term_months:'payment_term_months',
  monthly_payment:'monthly_solar_payment',first_year_monthly_payment:'first_year_monthly_payment',payment_basis:'payment_basis',
  current_balance:'remaining_balance',contract_amount:'total_financed',utility_bill_amount:'monthly_utility_bill',
  term_start_basis:'term_start_basis',effective_date_basis:'effective_date_basis',
  customer_name:'signer_name',address:'address_line1',city:'city',state:'state',zip:'zip',
  utility:'utility_name',utility_account_number:'utility_account_number',finance_account_number:'account_number',
  annual_usage_kwh:'annual_usage_kwh',monthly_usage_kwh:'monthly_usage_kwh',production_guarantee:'production_guarantee',production_kwh:'production_kwh',buyout_terms:'buyout_terms',balloon_amount:'balloon_amount',cash_price:'cash_price',dealer_fee:'dealer_fee',balloon_expected:'balloon_expected',
};
export interface Evidence {
  value: string | null; confidence:'high'|'medium'|'low'; page:number|null; quote:string|null;
  document_id:string; source:string; run_id:string; provider:string; model:string|null;
  alternatives?:Evidence[]; unresolved?:boolean; staff_review_required:boolean;
}
export interface MappedDocument {
  documentId:string; fields:Record<string,Evidence>; classification:string[];
  readableAgreement:boolean; clientMatch:'matched'|'unclear'|'unrelated';
  coverage:{complete:boolean;totalPages:number;processedPages:number};
  runs:string[]; evidence:unknown[]; summary:string; costUsd:number;
}
const AGREEMENTS=new Set(['agreement','loan','lease','ppa']);
type ClassifiedDoc = { file: string; belongs_to_case: string; kind: string; summary?: string; page_start: number; page_end: number }
type AnalyzerField = {
  value?: unknown
  alternatives?: AnalyzerField[]
  evidence?: { file: string; page: number; quote?: string }
  level?: string
  source_run?: string
}
export type AnalyzerBatchResult = {
  coverage: { complete: boolean; processedPages: number; totalPages: number }
  run: { id: string }
  usage?: { cost?: number }
  documents?: ClassifiedDoc[]
  fields?: Record<string, AnalyzerField>
  model?: string
}
/** Resolve only equal candidates; differences survive for a human decision. */
export function resolveCandidates(candidates:Evidence[]):Evidence {
  if(!candidates.length) throw Error('Evidence candidates are required');
  const known=candidates.filter(c=>c.value!==null && c.value!=='' && !['unknown','unsure','not_sure'].includes(c.value.toLowerCase()));
  const values=new Set(known.map(c=>c.value!.trim().toLowerCase()));
  if(values.size>1 || candidates.some(c=>c.unresolved)) return {...known[0],value:null,confidence:'low',alternatives:known,staff_review_required:true};
  return {...(known[0] ?? candidates[0]),alternatives:known.length>1?known:undefined};
}
export function mapBatches(batches:{files:BatchFile[];result:AnalyzerBatchResult}[],reconciliation?:{fields?:Record<string, AnalyzerField>}):MappedDocument[] {
  const documents=new Map<string,MappedDocument>();
  const candidates=new Map<string,Record<string,Evidence[]>>();
  const pages=new Map<string,Set<number>>();
  for(const {files,result} of batches) {
    if(!result?.coverage?.complete) throw Error('Analyzer returned incomplete coverage');
    if(result.coverage.processedPages!==result.coverage.totalPages) throw Error('Analyzer omitted processed pages');
    if(result.coverage.totalPages!==files.reduce((n,f)=>n+f.pages,0)) throw Error('Batch page count does not match manifest');
    for(const file of files) {
      let d=documents.get(file.documentId);
      if(!d) { d={documentId:file.documentId,fields:{},classification:[],readableAgreement:false,clientMatch:'unclear',coverage:{complete:false,totalPages:0,processedPages:0},runs:[],evidence:[],summary:'',costUsd:0};documents.set(file.documentId,d);candidates.set(file.documentId,{});pages.set(file.documentId,new Set()); }
      for(let p=1;p<=file.pages;p++) {if(pages.get(file.documentId)!.has(file.pageOffset+p)) throw Error('A physical page was repeated between analyzer batches');pages.get(file.documentId)!.add(file.pageOffset+p);}
      if(!d.runs.includes(result.run.id)) d.runs.push(result.run.id);
      d.costUsd+=(result.usage?.cost??0)*file.pages/result.coverage.totalPages;
      const classified=(result.documents??[]).filter((c)=>c.file===file.name);
      for(const c of classified) {
        if(c.belongs_to_case==='no') { if(d.clientMatch!=='matched') d.clientMatch='unrelated'; continue; }
        if(c.belongs_to_case==='yes') d.clientMatch='matched';
        if(!d.classification.includes(c.kind)) d.classification.push(c.kind);
        if(AGREEMENTS.has(c.kind) && c.belongs_to_case==='yes') d.readableAgreement=true;
        d.summary ||= c.summary ?? '';
      }
      for(const [name,raw] of Object.entries(reconciliation?.fields??result.fields??{})) {
        const root=raw; const key=FIELD_MAP[name];
        const alternatives=[root,...(Array.isArray(root.alternatives)?root.alternatives:[])];
        for(const field of alternatives) {
        const cited=field.evidence
        if(!key || !cited || cited.file!==file.name || field.value===null || field.value===undefined) continue;
        if(classified.some((c)=>c.belongs_to_case==='no' && cited.page>=c.page_start && cited.page<=c.page_end)) continue;
        if(!Number.isInteger(cited.page) || cited.page<1 || cited.page>file.pages) throw Error('Analyzer citation is outside its source file');
        // Amount financed belongs to a loan. Cash/lease/PPA totals are not loan principal.
        if(key==='total_financed' && (reconciliation?.fields??result.fields)?.contract_type?.value!=='loan') continue;
        const evidence:Evidence={value:String(field.value),confidence:field.level==='high'?'high':field.level==='medium'?'medium':'low',
          page:file.pageOffset+cited.page,quote:cited.quote||null,document_id:file.documentId,source:file.originalName,
          run_id:field.source_run??result.run.id,provider:'records',model:result.model??null,unresolved:root.value==null && alternatives.length>1,staff_review_required:true};
        const items=candidates.get(file.documentId)![key]??=[];
        if(!items.some(e=>e.value===evidence.value && e.page===evidence.page && e.run_id===evidence.run_id)) {items.push(evidence);d.evidence.push(evidence);}
        }
      }
    }
  }
  for(const d of documents.values()) {
    const accounted=pages.get(d.documentId)!; const total=Math.max(...accounted);
    if(accounted.size!==total) throw Error('A physical page was omitted between analyzer batches');
    d.coverage={complete:true,totalPages:total,processedPages:accounted.size};
    d.fields=Object.fromEntries(Object.entries(candidates.get(d.documentId)!).map(([k,v])=>[k,resolveCandidates(v)]));
    const signed=d.fields.customer_signed_date;
    if(signed?.value && /^\d{4}-\d{2}-\d{2}$/.test(signed.value)) {
      d.fields.signed_year={...signed,value:signed.value.slice(0,4)};
      d.fields.signed_month={...signed,value:String(Number(signed.value.slice(5,7)))};
    }
  }
  return [...documents.values()];
}
