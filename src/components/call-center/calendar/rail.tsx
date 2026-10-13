'use client'

import Link from 'next/link'
import { useState } from 'react'
import { railWhen, timeLabel, type RailLeadVM, type RepVM, type VisitVM } from '@/lib/call-center/calendar/planner'
import { leadHref } from '@/lib/call-center/lead-link'
import { phoneText, type LeadPhoneView } from '@/lib/call-center/phone-display'
import { repOf } from './visit-block'

function who(lead: { last4: string | null; language: 'EN' | 'ES'; phone?: LeadPhoneView | null }): string {
  const number = lead.phone ? phoneText(lead.phone, null) : lead.last4 ? `••${lead.last4}` : null
  return [number, lead.language === 'ES' ? 'Spanish' : 'English'].filter(Boolean).join(' · ')
}

/**
 * The right column on a desk; a collapsible section above the grid on a phone.
 * Next 3 hours, leads still to book (Book opens the scheduler), follow-ups.
 */
export function Rail({
  now,
  reps,
  nextHours,
  toSchedule,
  followUps,
  onBook,
}: {
  now: Date
  reps: RepVM[]
  nextHours: VisitVM[]
  toSchedule: RailLeadVM[]
  followUps: RailLeadVM[]
  onBook: (lead: RailLeadVM) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <aside className={`cal-rail${open ? ' open' : ''}`} aria-label="Visits and leads to book">
      <button type="button" className="cal-rail-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>
          Next 3 h <b>{nextHours.length}</b> · To schedule <b>{toSchedule.length}</b> · Follow-ups <b>{followUps.length}</b>
        </span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <div className="cal-rail-body">
        <section className="cal-rail-sec">
          <h3>Next 3 hours</h3>
          {nextHours.length ? (
            <ul>
              {nextHours.map((visit) => (
                <li key={visit.id} className={`cal-rail-row cal-rep-${repOf(reps, visit.repKey).color}`}>
                  <i className="cal-dot" aria-hidden="true" />
                  <span className="cal-rail-text">
                    <b>{timeLabel(visit.startsAt)} {visit.name}</b>
                    <small>{repOf(reps, visit.repKey).label} · {visit.status === 'HOLD' ? 'Hold' : 'Confirmed'}</small>
                  </span>
                  <Link prefetch={false} className="cal-rail-btn" href={leadHref(visit.leadId)}>Call</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No visits in the next 3 hours.</p>
          )}
        </section>
        <section className="cal-rail-sec">
          <h3>To schedule ({toSchedule.length})</h3>
          {toSchedule.length ? (
            <ul>
              {toSchedule.map((lead) => (
                <li key={lead.id} className="cal-rail-row">
                  <span className="cal-rail-text">
                    <b>{lead.name}</b>
                    <small>{who(lead)} · came in {railWhen(lead.at, now)}</small>
                  </span>
                  <button type="button" className="cal-rail-btn" onClick={() => onBook(lead)}>Book</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Every open lead has a visit on the calendar.</p>
          )}
        </section>
        <section className="cal-rail-sec">
          <h3>Follow-ups ({followUps.length})</h3>
          {followUps.length ? (
            <ul>
              {followUps.map((lead) => (
                <li key={lead.id} className="cal-rail-row">
                  <span className="cal-rail-text">
                    <b>{lead.name}</b>
                    <small>Next try {railWhen(lead.at, now)} · {who(lead)}</small>
                  </span>
                  <Link prefetch={false} className="cal-rail-btn" href={leadHref(lead.id)}>Open</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No follow-ups due in the next 24 hours.</p>
          )}
        </section>
      </div>
    </aside>
  )
}
