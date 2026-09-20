import { QUESTIONS } from './questions'

export type FilterField = { key: string; label: string; group: string; type: 'text' | 'number' | 'date' | 'choice' | 'multi'; options?: string[] }
export type FilterValue = string | number | boolean | string[] | null
export type FilterRule = { field: string; operator: string; value?: string | string[] }
export type FilterGroup = { operator: 'AND' | 'OR'; rules: FilterRule[] }
export type ClientFilter = { operator: 'AND' | 'OR'; groups: FilterGroup[] }
export type ClientQuery = { filters?: string; scheduling?: string; page?: string }
export const emptyFilter = (): ClientFilter => ({ operator: 'AND', groups: [] })
export const operatorsFor = (type: FilterField['type']) => ['known', 'unknown', 'not_applicable', 'equals', 'not_equals',
  ...(type === 'number' || type === 'date' ? ['gt', 'gte', 'lt', 'lte', 'between'] : type === 'multi' ? ['any', 'all', 'none'] : type === 'text' ? ['contains'] : [])]
export const FINANCE_FILTERS = ['Total / amount financed', 'Remaining balance', 'Interest rate', 'Interest paid to date', 'Annual Escalator Rate %', 'Term years', 'Term months', 'Years remaining', 'Months remaining', 'Monthly payment', '30% Dealer Fee', 'Lender', 'First payment date']
export const financeKey = (label: string) => 'finance.' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_')
export const BASE_FILTER_FIELDS: FilterField[] = [
  ...['name', 'email', 'phone', 'state', 'city', 'zip', 'source', 'stage', 'closer'].map(key => ({ key, label: key === 'closer' ? 'Assigned closer' : key[0].toUpperCase()+key.slice(1), group: 'Client', type: 'text' as const })),
  { key: 'status', label: 'Client status', group: 'Client', type: 'choice', options: ['ACTIVE','ON_HOLD','DISQUALIFIED','CLOSED_WON','CLOSED_LOST'] },
  { key: 'scheduling', label: 'Call scheduled', group: 'Appointments', type: 'choice', options: ['scheduled', 'unscheduled'] },
  { key: 'appointment.status', label: 'Next call status', group: 'Appointments', type: 'choice', options: ['SCHEDULED','CONFIRMED'] },
  { key: 'appointment.history_status', label: 'Any appointment status', group: 'Appointments', type: 'multi', options: ['SCHEDULED','CONFIRMED','COMPLETED','NO_SHOW','CANCELLED','RESCHEDULED'] },
  { key: 'appointment.last_date', label: 'Most recent appointment date', group: 'Appointments', type: 'date' },
  { key: 'appointment.date', label: 'Next call date', group: 'Appointments', type: 'date' },
  { key: 'questionnaire.progress', label: 'Questionnaire progress', group: 'Questionnaire', type: 'choice', options: ['not_started','in_progress','completed'] },
  { key: 'questionnaire.count', label: 'Questionnaire answered count', group: 'Questionnaire', type: 'number' },
  ...QUESTIONS.map(q => ({ key: 'question.'+q.id, label: q.l, group: 'Questionnaire answers', type: q.ty === 'multi' ? 'multi' as const : q.ty === 'one' ? 'choice' as const : 'text' as const, options: q.o })),
  { key: 'credit.score', label: 'Credit score (exact)', group: 'Credit', type: 'number' },
  { key: 'credit.range', label: 'Credit range (reported)', group: 'Credit', type: 'text' },
  ...FINANCE_FILTERS.map(label => ({ key: financeKey(label), label, group: 'Finance', type: label === 'Lender' ? 'text' as const : label === 'First payment date' ? 'date' as const : 'number' as const })),
  { key: 'finance.payment_basis', label: 'Monthly payment period', group: 'Finance', type: 'choice', options: ['first_year','contract_stated'] },
  ...['Agreement type','Installer','System size'].map(label => ({ key: 'solar.'+label.toLowerCase().replace(/ /g,'_'), label, group:'Solar', type: label === 'System size' ? 'number' as const : 'text' as const })),
  { key: 'extraction', label: 'Agreement extraction review', group:'Documents', type:'choice', options:['none','unverified','verified'] },
  { key:'cys.progress',label:'CYS required fields',group:'CYS',type:'choice',options:['incomplete','complete'] },
]

export class InvalidFilterError extends Error {}
export function parseClientFilter(raw: string | undefined, fields: FilterField[]): ClientFilter {
  if (!raw) return emptyFilter()
  if (raw.length > 24000) throw new InvalidFilterError('Filter is too large.')
  let input: ClientFilter
  try { input = JSON.parse(raw) } catch { throw new InvalidFilterError('Invalid filter JSON.') }
  if (!input || !['AND','OR'].includes(input.operator) || !Array.isArray(input.groups) || input.groups.length > 8) throw new InvalidFilterError('Invalid filter groups.')
  const catalog = new Map(fields.map(f=>[f.key,f]))
  let count = 0
  for (const group of input.groups) {
    if (!group || !['AND','OR'].includes(group.operator) || !Array.isArray(group.rules) || !group.rules.length) throw new InvalidFilterError('Each group needs at least one rule.')
    for (const rule of group.rules) {
      if (++count > 40) throw new InvalidFilterError('Use at most 40 filter rules.')
      const f = rule && catalog.get(rule.field)
      if (!f || !operatorsFor(f.type).includes(rule.operator)) throw new InvalidFilterError('Unknown field or unsupported operator.')
      if (['known','unknown','not_applicable'].includes(rule.operator)) continue
      const values = Array.isArray(rule.value) ? rule.value : [rule.value]
      if (!values.length || values.some(v=>typeof v!=='string'||!v.trim()||v.length>1000)) throw new InvalidFilterError('Enter a value for each rule.')
      if (f.type!=='multi' && rule.operator!=='between' && values.length!==1) throw new InvalidFilterError('This rule accepts one value.')
      if (f.options && values.some(v=>!f.options!.includes(v!))) throw new InvalidFilterError('Choose a supported value.')
      if (rule.operator==='between' && values.length!==2) throw new InvalidFilterError('A range needs two values.')
      if ((f.type==='number'||f.type==='date') && values.some(v=>comparable(v!,f.type)===null)) throw new InvalidFilterError('Enter a valid number or date.')
    }
  }
  return input
}
export function isUnknown(value: FilterValue | undefined): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return !value.length || value.every(isUnknown)
  return typeof value === 'string' && /^(?:\s*|unknown|unsure|not[ _-]?sure|not on file|missing|cannot compute)$/i.test(value.trim())
}
export const notApplicable = (value: FilterValue | undefined) => typeof value==='string' && /^(?:n\/?a|not applicable)$/i.test(value.trim())
export function comparable(value: string | number | boolean, type: FilterField['type']): number | null {
  if(type==='date'){const s=String(value);if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(s))return null;const n=Date.parse(s);return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s.slice(0,10)?n:null}
  const s=String(value).trim().replace(/[$,%]/g,'').replace(/\s*(?:kW|years?|months?)$/i,'').trim()
  return /^-?\d+(?:\.\d+)?$/.test(s)&&Number.isFinite(Number(s))?Number(s):null
}
export function matchesRule(value: FilterValue | undefined, rule: FilterRule, field: FilterField): boolean {
  const unknown = isUnknown(value) && !(value==='missing' && (field.key.startsWith('doc.') || field.key.startsWith('doc_processing.')))
  if(rule.operator==='unknown')return unknown
  if(rule.operator==='not_applicable')return notApplicable(value)
  if(rule.operator==='known')return !unknown&&!notApplicable(value)
  if(unknown||notApplicable(value))return false
  const actual=(Array.isArray(value)?value:[value]).map(v=>String(v).trim().toLowerCase())
  const expected=(Array.isArray(rule.value)?rule.value:[rule.value!]).map(v=>v.trim().toLowerCase())
  if(field.type==='number'||field.type==='date'){
    const a=comparable(actual[0],field.type),b=comparable(expected[0],field.type),c=expected[1]===undefined?null:comparable(expected[1],field.type)
    if(a===null||b===null)return false
    switch(rule.operator){case 'equals':return a===b;case 'not_equals':return a!==b;case 'gt':return a>b;case 'gte':return a>=b;case 'lt':return a<b;case 'lte':return a<=b;case 'between':return c!==null&&a>=b&&a<=c;default:return false}
  }
  switch(rule.operator){case 'equals':return actual.length===expected.length&&expected.every(v=>actual.includes(v));case 'not_equals':return !(actual.length===expected.length&&expected.every(v=>actual.includes(v)));case 'contains':return actual.some(v=>v.includes(expected[0]));case 'any':return expected.some(v=>actual.includes(v));case 'all':return expected.every(v=>actual.includes(v));case 'none':return expected.every(v=>!actual.includes(v));default:return false}
}
export function matchesFilter(values: Record<string, FilterValue>, filter: ClientFilter, fields: FilterField[]): boolean {
  const catalog=new Map(fields.map(f=>[f.key,f]));if(!filter.groups.length)return true
  const groups=filter.groups.map(g=>{const rules=g.rules.map(r=>matchesRule(values[r.field],r,catalog.get(r.field)!));return g.operator==='AND'?rules.every(Boolean):rules.some(Boolean)})
  return filter.operator==='AND'?groups.every(Boolean):groups.some(Boolean)
}
