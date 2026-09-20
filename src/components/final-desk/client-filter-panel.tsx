'use client'
import { useState } from 'react'
import { emptyFilter, operatorsFor, type ClientFilter, type FilterField, type FilterRule } from '@/lib/final-desk/filters'

export function ClientFilterPanel({ fields, current, scheduling, onApply }: {
  fields: FilterField[]; current: ClientFilter; scheduling?: string;
  onApply: (filter: ClientFilter, scheduling?: string) => void;
}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(current)
  const update=(g:number,r:number,rule:FilterRule)=>setDraft({...draft,groups:draft.groups.map((group,i)=>i===g?{...group,rules:group.rules.map((old,j)=>j===r?rule:old)}:group)})
  const count=current.groups.reduce((n,g)=>n+g.rules.length,0)+(scheduling?1:0)
  const label=(s:string)=>s.replaceAll('_',' ')
  const newRule=():FilterRule=>({field:'scheduling',operator:'equals',value:'unscheduled'})
  return <>
    <button className="btn secondary" onClick={()=>{setDraft(current);setOpen(true)}}>Filters{count?` · ${count}`:''}</button>
    {scheduling && <button className="tag" onClick={()=>onApply(current,undefined)} aria-label="Remove unscheduled filter">Unscheduled ×</button>}
    {open && <div className="modal on"><section className="box filter-box" role="dialog" aria-modal="true" aria-label="Client filters">
      <div className="head"><h3>Filter clients</h3><button className="btn secondary" onClick={()=>setOpen(false)}>Close</button></div>
      <p className="muted">AND requires every rule; OR accepts any rule. Unknown includes missing and unsure answers.</p>
      {scheduling && <p className="tag">Active unscheduled clients</p>}
      <label>Combine groups <select aria-label="Combine filter groups" value={draft.operator} onChange={e=>setDraft({...draft,operator:e.target.value as 'AND'|'OR'})}><option>AND</option><option>OR</option></select></label>
      {draft.groups.map((group,g)=><fieldset className="filter-group" key={g}><legend>Group {g+1}</legend>
        <label>Match rules with <select aria-label={`Group ${g+1} operator`} value={group.operator} onChange={e=>setDraft({...draft,groups:draft.groups.map((old,i)=>i===g?{...old,operator:e.target.value as 'AND'|'OR'}:old)})}><option>AND</option><option>OR</option></select></label>
        {group.rules.map((rule,r)=>{const f=fields.find(f=>f.key===rule.field)!;return <div className="filter-rule" key={r}>
          <select aria-label={`Group ${g+1} rule ${r+1} field`} value={rule.field} onChange={e=>update(g,r,{field:e.target.value,operator:'known'})}>
            {[...new Set(fields.map(f=>f.group))].map(group=><optgroup key={group} label={group}>{fields.filter(f=>f.group===group).map(f=><option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)}
          </select>
          <select aria-label={`Group ${g+1} rule ${r+1} operator`} value={rule.operator} onChange={e=>update(g,r,{...rule,operator:e.target.value,value:undefined})}>{operatorsFor(f.type).map(op=><option key={op} value={op}>{label(op)}</option>)}</select>
          {!['known','unknown','not_applicable'].includes(rule.operator) && (f.options ? <select aria-label={`Group ${g+1} rule ${r+1} value`} multiple={f.type==='multi'} value={f.type==='multi'?(Array.isArray(rule.value)?rule.value:[]):String(rule.value??'')} onChange={e=>update(g,r,{...rule,value:f.type==='multi'?Array.from(e.target.selectedOptions).map(o=>o.value):e.target.value})}>
            {f.type!=='multi'&&<option value="">Select value</option>}{f.options.map(o=><option key={o} value={o}>{label(o)}</option>)}
          </select> : rule.operator==='between' ? <div className="filter-range">{[0,1].map(index=><input key={index} aria-label={`Group ${g+1} rule ${r+1} ${index?'maximum':'minimum'}`} type={f.type==='date'?'date':'number'} step="any" value={Array.isArray(rule.value)?rule.value[index]??'':''} onChange={e=>{const values=Array.isArray(rule.value)?[...rule.value]:['',''];values[index]=e.target.value;update(g,r,{...rule,value:values})}} />)}</div>
          : <input aria-label={`Group ${g+1} rule ${r+1} value`} type={f.type==='date'?'date':f.type==='number'?'number':'text'} step="any" value={String(rule.value??'')} onChange={e=>update(g,r,{...rule,value:e.target.value})} />)}
          <button className="btn secondary" aria-label={`Remove group ${g+1} rule ${r+1}`} onClick={()=>setDraft({...draft,groups:draft.groups.map((old,i)=>i===g?{...old,rules:old.rules.filter((_,j)=>j!==r)}:old).filter(group=>group.rules.length)})}>×</button>
        </div>})}
        <button className="btn secondary" onClick={()=>setDraft({...draft,groups:draft.groups.map((old,i)=>i===g?{...old,rules:[...old.rules,newRule()]}:old)})}>Add rule</button>
      </fieldset>)}
      <button className="btn secondary" onClick={()=>setDraft({...draft,groups:[...draft.groups,{operator:'AND',rules:[newRule()]}]})}>Add group</button>
      <p className="filter-expression" aria-label="Filter expression">{[scheduling?'Active AND Unscheduled':'',draft.groups.map(g=>'('+g.rules.map(r=>`${fields.find(f=>f.key===r.field)?.label} ${label(r.operator)} ${Array.isArray(r.value)?r.value.join(', '):r.value??''}`).join(` ${g.operator} `)+')').join(` ${draft.operator} `)].filter(Boolean).join(' AND ')||'All clients you can access'}</p>
      <div className="actions"><button className="btn" onClick={()=>{onApply(draft,scheduling);setOpen(false)}}>Apply filters</button><button className="btn secondary" onClick={()=>{onApply(emptyFilter(),undefined);setOpen(false)}}>Clear all</button></div>
    </section></div>}
  </>
}
