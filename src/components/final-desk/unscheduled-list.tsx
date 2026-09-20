'use client'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { DeskBoard } from '@/lib/daily-desk'

export function UnscheduledList({ board, calendarRef, dayMode, busy, open, viewAll }: {
  board: DeskBoard; calendarRef: RefObject<HTMLDivElement|null>; dayMode: boolean; busy: boolean;
  open:(id:string)=>void;viewAll:()=>void;
}) {
  const panel=useRef<HTMLElement>(null),list=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(0)
  useLayoutEffect(()=>{
    const measure=()=>{
      if(!panel.current||!list.current||!calendarRef.current)return
      panel.current.style.height=`${window.innerWidth<=980?400:calendarRef.current.getBoundingClientRect().height}px`
      const bounds=list.current.getBoundingClientRect()
      const cards=[...list.current.children] as HTMLElement[]
      setVisible(cards.filter(card=>card.getBoundingClientRect().bottom<=bounds.bottom+1).length)
    }
    measure();const observer=new ResizeObserver(measure)
    if(calendarRef.current)observer.observe(calendarRef.current)
    if(list.current)observer.observe(list.current)
    window.addEventListener('resize',measure)
    return()=>{observer.disconnect();window.removeEventListener('resize',measure)}
  },[board.unscheduled,calendarRef,dayMode])
  return <aside className="card side unscheduled-panel" ref={panel}>
    <h3>Unscheduled · {board.unscheduledTotal}</h3><p className="muted">{dayMode?'Drag onto an hour.':'Drag onto a day or click the file.'}</p>
    <div className="unscheduled-list" ref={list}>{board.unscheduled.map((c,i)=><div key={c.clientId} className="lead" style={{visibility:i<visible?'visible':'hidden'}} aria-hidden={i>=visible} draggable={board.canBook&&!busy&&i<visible} onDragStart={e=>{if(busy){e.preventDefault();return}e.dataTransfer.setData('text/plain',c.clientId)}} onClick={()=>i<visible&&open(c.clientId)}><b>{c.firstName} {c.lastName}</b><span>{c.missingDocs?`${c.missingDocs} required documents missing`:'Documents on file'}</span></div>)}</div>
    {!board.unscheduledTotal&&<p className="muted">No unscheduled clients.</p>}
    <button className="btn secondary view-unscheduled" onClick={viewAll}>view all unscheduled clients</button>
  </aside>
}
