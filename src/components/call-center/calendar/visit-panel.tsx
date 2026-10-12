'use client'

import Link from 'next/link'
import { useState } from 'react'
import { confirmCalendarSlot, saveCalendarOutcome, type CalendarResult } from '@/lib/call-center/calendar/actions'
import type { CalendarOutcome } from '@/lib/call-center/calendar/outcomes'
import { isLive, reasonText, statusLook, visitWhen, type RepVM, type VisitVM } from '@/lib/call-center/calendar/planner'
import { leadHref } from '@/lib/call-center/lead-link'

const DONE: Record<string, string> = {
  confirm: 'Visit confirmed.',
  sat: 'Saved: the client sat.',
  'no-show': 'Saved as a no-show. The lead is back on the desk for a call back in 2 hours.',
  rescheduled: 'Marked rescheduled.',
  cancelled: 'Visit cancelled.',
}

/**
 * A clicked visit: the side panel on a desk, a bottom sheet on a phone.
 * It only renders with a visit, so no empty sheet ever shows.
 */
export function VisitPanel({
  visit,
  rep,
  onClose,
  onReschedule,
  onChanged,
}: {
  visit: VisitVM
  rep: RepVM
  onClose: () => void
  onReschedule: (visit: VisitVM) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [askCancel, setAskCancel] = useState(false)
  const look = statusLook(visit.status)
  const live = isLive(visit.status)

  async function run(key: string, act: () => Promise<CalendarResult>) {
    setBusy(true)
    setMsg(null)
    let res: CalendarResult
    try {
      res = await act()
    } catch {
      res = { ok: false, reason: 'Could not save. Check the connection and try again.' }
    }
    setBusy(false)
    setAskCancel(false)
    setMsg(res.ok ? { ok: true, text: DONE[key] } : { ok: false, text: reasonText(res.reason) })
    if (res.ok) onChanged()
  }

  const outcome = (o: CalendarOutcome) => run(o, () => saveCalendarOutcome(visit.id, o))

  return (
    <>
      <div className="cal-panel-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        className={`cal-panel cal-rep-${rep.color}`}
        aria-label={`Visit: ${visit.name}`}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onClose()
        }}
      >
        <div className="cal-grab" aria-hidden="true" />
        <header className="cal-panel-head">
          <div>
            <h3>{visit.name}</h3>
            <p className="cal-panel-when">{visitWhen(visit.startsAt, visit.endsAt)} · Pacific</p>
          </div>
          <button type="button" className="cal-x" aria-label="Close the visit" onClick={onClose}>×</button>
        </header>
        <div className="cal-panel-tags">
          <span className="cal-tag cal-tag-rep"><i className="cal-dot" aria-hidden="true" />{rep.label}</span>
          <span className={`cal-tag cal-st-${look.look}`}>{look.label}</span>
          <span className="cal-tag">{visit.language === 'ES' ? 'Spanish' : 'English'}</span>
          {visit.last4 ? <span className="cal-tag">••{visit.last4}</span> : null}
        </div>
        <div className="cal-panel-note">
          <small>Last note</small>
          <p>{visit.note ?? 'No note on this lead yet.'}</p>
        </div>
        <div className="cal-panel-acts">
          <Link className="btn secondary" href={leadHref(visit.leadId)}>Open lead</Link>
          {visit.status === 'HOLD' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => { void run('confirm', () => confirmCalendarSlot(visit.id)) }}>
              Confirm (on the call)
            </button>
          ) : null}
          {live ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => onReschedule(visit)}>Reschedule</button>
          ) : null}
        </div>
        {live ? (
          <>
            <h4>Outcome</h4>
            <div className="cal-panel-acts">
              {visit.status === 'CONFIRMED' ? (
                <>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => { void outcome('sat') }}>Sat</button>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => { void outcome('no-show') }}>No-show</button>
                </>
              ) : null}
              <button type="button" className="btn secondary" disabled={busy} onClick={() => { void outcome('rescheduled') }}>Rescheduled</button>
              {askCancel ? (
                <button type="button" className="btn cal-danger" disabled={busy} onClick={() => { void outcome('cancelled') }}>Yes, cancel it</button>
              ) : (
                <button type="button" className="btn secondary" disabled={busy} onClick={() => setAskCancel(true)}>Cancel visit</button>
              )}
            </div>
            {visit.status === 'HOLD' ? <p className="muted">Sat and No-show open once the hold is confirmed on a call.</p> : null}
          </>
        ) : (
          <p className="muted">This visit is closed ({look.label.replace('✓ ', '')}).</p>
        )}
        {msg ? <p className={`cal-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p> : null}
      </aside>
    </>
  )
}
